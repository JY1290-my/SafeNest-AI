"""Tk frontend for local settings. No web server or remote control endpoints."""
import json
import os
import time
import queue
import threading
from camera_catalog import CameraCatalog, pair_device
from device_claim import issue_claim, cancel_claim, read_home_code, ClaimError
from device_settings import CaptureLease, SettingsStore, DeviceSetupError
from room_calibration import RoomCalibration


def run_ui(root, launcher_type):
    try:
        import tkinter as tk
        from tkinter import ttk, messagebox
        window = tk.Tk()
    except Exception:
        print('Camera setup requires Python tkinter and a desktop session. See README.')
        return 1
    window.title('SafeNest AI - Device setup')
    window.geometry('720x780'); window.minsize(560, 440)
    style = ttk.Style(window)
    style.configure('Setup.TFrame', background='#f4f5ef')
    style.configure('Setup.TLabel', background='#f4f5ef', foreground='#183c35', font=('Segoe UI',10))
    style.configure('Title.TLabel', background='#f4f5ef', foreground='#183c35', font=('Segoe UI',22,'bold'))
    style.configure('Setup.TButton', font=('Segoe UI',10), padding=10)
    canvas = tk.Canvas(window, background='#f4f5ef', highlightthickness=0)
    scroll = ttk.Scrollbar(window, orient='vertical', command=canvas.yview)
    canvas.configure(yscrollcommand=scroll.set)
    scroll.pack(side='right',fill='y'); canvas.pack(side='left',fill='both',expand=True)
    panel = ttk.Frame(canvas, style='Setup.TFrame', padding=24)
    panel_id = canvas.create_window((0,0),window=panel,anchor='nw')
    labels=[]; actions=[]; fields=[]
    def text(value, title=False):
        item=ttk.Label(panel,text=value,style='Title.TLabel' if title else 'Setup.TLabel',wraplength=640,justify='left')
        item.pack(anchor='w',fill='x',pady=(0,12));labels.append(item);return item
    text('LOCAL DEVICE SETUP')
    text('Camera setup',True)
    text('Choose the camera connected to this computer, name its view and mark the bed. '
         'Setup preview does not run AI monitoring or send video to family members.')
    status=tk.StringVar(value='Ready. Scan or preview only when you choose to.')
    identity=text('Reading local device configuration…')
    try:
        with CaptureLease(root):
            store=SettingsStore(root).ensure()
        chosen=store.current()
    except (DeviceSetupError,ImportError,OSError) as exc:
        identity.configure(text=str(exc) if isinstance(exc,DeviceSetupError) else 'Use your existing SafeNest virtual environment.')
        window.mainloop();return 1
    identity.configure(text=store.device_status)
    home_label=text('Home ID unavailable — checking requires a registered cloud device.')
    home_results=queue.Queue();home_pending=False;home_device=''
    def refresh_home():
        nonlocal home_pending,home_device
        if home_pending:return
        home_device='';home_label.configure(text='Home ID unavailable')
        try:device=SettingsStore(root).device_id
        except Exception:device=''
        if not device:return
        home_pending=True;home_button.state(['disabled'])
        home_label.configure(text='Checking Home ID…')
        def work():
            try:result=read_home_code(root,device,with_name=True)
            except Exception:result=None
            home_results.put((device,result))
        threading.Thread(target=work,daemon=True).start()
    home_button=ttk.Button(panel,text='Refresh Home ID',command=refresh_home,style='Setup.TButton')
    home_button.pack(fill='x',pady=(0,10))
    source=tk.StringVar(value=str(chosen.source));profile=tk.StringVar(value=chosen.profile)
    room=tk.StringVar(value=chosen.room);name=tk.StringVar(value=chosen.camera_name)
    def field(title,var,combo=False):
        text(title)
        widget=ttk.Combobox(panel,textvariable=var,values=list(map(str,range(10)))) if combo else ttk.Entry(panel,textvariable=var)
        widget.pack(fill='x',pady=(0,14));fields.append(widget);return widget
    camera=field('Camera index (scan 0–9, or enter 0–31)',source,True)
    field('View profile (for example bedroom_front)',profile)
    field('Room name',room)
    field('Camera name',name)
    calibration_label=text('Needs confirmation')
    launcher=launcher_type(root)
    camera_pending=False; camera_results=queue.Queue()
    claim_pending=False; claim_deadline=0; claim_results=queue.Queue()
    claim_code=tk.StringVar(value="")
    def describe(value):
        try:cal=RoomCalibration(value.calibration_path(root),str(value.source),value.profile,device_scope=value.scope)
        except DeviceSetupError as exc:
            calibration_label.configure(text='Setup unavailable — '+str(exc));return
        calibration_label.configure(text=('Needs confirmation — saved outline available. Confirm on the current live view.'
            if cal.polygon else 'Not calibrated — mark the bed in Preview & calibrate.'))
    describe(chosen)
    def load_selected(event=None):
        nonlocal store
        if launcher.running or claim_pending or camera_pending:return
        try:
            current=SettingsStore(root)
            if current.scope!=store.scope:raise DeviceSetupError('Device identity changed. Reopen Camera setup before saving.')
            store=current
            value=store.selection(source.get(),profile.get())
            room.set(value.room);name.set(value.camera_name);describe(value)
            status.set('Loaded labels for this device, camera and view profile. Save to select this setup.')
        except DeviceSetupError as exc:status.set(str(exc))
    def save():
        nonlocal store
        if claim_pending or camera_pending:return False
        try:
            with CaptureLease(root):
                fresh=SettingsStore(root)
                if fresh.scope!=store.scope:raise DeviceSetupError('Device identity changed. Reopen Camera setup before saving.')
                value=fresh.save(source.get(),profile.get(),room.get(),name.get())
                store=fresh
            describe(value)
            status.set('Settings saved locally. Register selected camera to publish its labels; cloud access is not verified here.')
            return True
        except (DeviceSetupError,OSError) as exc:
            status.set(str(exc) if isinstance(exc,DeviceSetupError) else 'Settings could not be saved. The previous settings were kept.')
            return False
    def busy(value):
        for widget in fields+actions:widget.state(['disabled'] if value else ['!disabled'])
        if os.name!='nt':
            start_button.state(['disabled'])
            all_button.state(['disabled'])
        close_button.state(['!disabled'] if value and launcher.mode in ('scan','preview') else ['disabled'])
        claim_controls()
    def launch(kind):
        try:
            if launcher.running or claim_pending or camera_pending:return
            if kind!='scan' and not save():return
            clear_claim()
            getattr(launcher,kind)()
            busy(True)
            status.set('Scanning cameras 0–9… Camera lights may briefly turn on.' if kind=='scan'
                else 'Setup preview opened. Use C to draw, E to edit, B / Enter to confirm, R to clear this camera\'s saved bed zone and Q to close. AI is not running.' if kind=='preview'
                else 'Monitoring process started. Confirm the saved bed outline in the live window. Use Q there to stop.')
        except (ValueError,OSError) as exc:
            status.set(str(exc) if isinstance(exc,DeviceSetupError) else 'Could not start. Check your environment, camera availability and model file.')
        except Exception as exc:
            # Launcher exceptions contain safe authored messages only.
            from camera_setup import SetupError
            status.set(str(exc) if isinstance(exc,SetupError) else 'Could not start local camera setup.')
    def button(title,command):
        widget=ttk.Button(panel,text=title,command=command,style='Setup.TButton')
        widget.pack(fill='x',pady=(0,10));actions.append(widget);return widget
    button('Scan cameras',lambda:launch('scan'))
    button('Load labels for selected camera / view',load_selected)
    button('Save device settings',save)
    button('Preview & calibrate',lambda:launch('preview'))
    close_button=ttk.Button(panel,text='Close setup preview / cancel scan',command=lambda:launcher.stop_setup(),style='Setup.TButton')
    close_button.pack(fill='x',pady=(0,10));close_button.state(['disabled'])
    start_button=button('Start monitoring',lambda:launch('start'))
    if os.name!='nt':start_button.state(['disabled'])
    text('Cameras linked to this computer',True)
    camera_list=text('No cameras registered locally yet.')
    def refresh_camera_list():
        try:
            entries=CameraCatalog(root).entries()
            camera_list.configure(text='\n'.join(f'{c.camera_name} · Local index {c.source} · Needs live confirmation' for c,b in entries) or 'No cameras registered locally yet.')
        except DeviceSetupError as exc:camera_list.configure(text=str(exc))
    refresh_camera_list()
    text('Join an existing Home',True)
    text('For a newly registered, unclaimed computer: ask the Home manager for a camera setup code. '
         'Enter it here before registering a camera. Already-created Homes are not merged or moved.')
    pairing_entry=ttk.Entry(panel,show='•')
    pairing_entry.pack(fill='x',pady=(0,10));fields.append(pairing_entry)
    def camera_action(pair=False,remove=False):
        nonlocal camera_pending
        if launcher.running or claim_pending or camera_pending:return
        if not save():return
        device=store.device_id
        if not device:status.set('Register this monitoring computer locally first.');return
        code=pairing_entry.get().strip() if pair else ''
        pairing_entry.delete(0,'end')
        if pair and not code:status.set('Enter the camera setup code from your Home manager.');return
        selected=store.current()
        camera_pending=True;busy(True)
        status.set('Joining existing Home…' if pair else 'Updating local camera registration…')
        def work():
            try:
                catalog=CameraCatalog(root)
                result=pair_device(root,device,code) if pair else catalog.remove_local(selected.key) if remove else catalog.register(selected)
                camera_results.put((device,None))
            except Exception as exc:
                camera_results.put((device,str(exc) if isinstance(exc,(ClaimError,DeviceSetupError)) else 'Camera setup could not be confirmed. Check your connection and refresh before retrying.'))
        threading.Thread(target=work,daemon=True).start()
    button('Join Home with camera setup code',lambda:camera_action(True))
    button('Register selected camera to this Home',camera_action)
    button('Remove selected camera from local run list',lambda:camera_action(remove=True))
    all_button=button('Start all registered cameras',lambda:launch('start_all'))
    if os.name!='nt':all_button.state(['disabled'])
    text('Adding a camera does not start monitoring. Each registered local camera runs independently when you choose Start all registered cameras. '
         'Removing a local entry does not delete cloud history; a Home manager can mark a retired camera Disabled on the family website.')
    text('Create a new Home',True)
    text('Only for the FIRST computer of a new Home. To join an existing Home, use its camera setup code above instead. For an unclaimed, registered monitoring device: generate a one-use code, then sign in to the family website and choose Set up a monitoring device. The account that redeems it becomes this home’s device manager. Only share it with the intended manager.')
    claim_entry=ttk.Entry(panel,textvariable=claim_code,state='readonly')
    claim_entry.pack(fill='x',pady=(0,10))
    claim_info=text('No code generated. Codes expire in 10 minutes. Creating a code does not open the camera.')
    def claim_controls():
        blocked=claim_pending or camera_pending or launcher.running
        generate_button.state(['disabled'] if blocked else ['!disabled'])
        for widget in (copy_button,revoke_button):
            widget.state(['disabled'] if blocked or not claim_code.get() else ['!disabled'])
    def clear_claim():
        nonlocal claim_deadline
        claim_code.set('');claim_deadline=0
        claim_controls()
    def claim_action(revoke=False):
        nonlocal claim_pending,claim_deadline
        if launcher.running or claim_pending or camera_pending:return
        if not save():return
        device=store.device_id
        if not device:
            status.set('Register this monitoring device first. Configure its device ID and credentials locally; this page never displays them.')
            return
        code=claim_code.get()
        if revoke and not code:return
        # Time from BEFORE request, so network delays cannot extend the display lifetime.
        deadline=time.monotonic()+600
        if not revoke:clear_claim()
        claim_pending=True;busy(True)
        status.set('Revoking claim code…' if revoke else 'Requesting a one-use device claim code…')
        def work():
            try:
                result=cancel_claim(root,device,code) if revoke else issue_claim(root,device)
                claim_results.put((device,revoke,deadline,result,None))
            except Exception as exc:
                message=str(exc) if isinstance(exc,ClaimError) else 'Could not complete device claim request. Check the local configuration and connection.'
                claim_results.put((device,revoke,deadline,None,message))
        threading.Thread(target=work,daemon=True).start()
    def copy_claim():
        if claim_pending or not claim_code.get() or time.monotonic()>=claim_deadline:return
        try:
            window.clipboard_clear();window.clipboard_append(claim_code.get())
            status.set('Claim code copied. Paste it only into Set up a monitoring device on your family website. Your clipboard may retain it.')
        except Exception:status.set('Clipboard unavailable. Select and copy the displayed claim code manually.')
    generate_button=button('Generate device claim code',claim_action)
    copy_button=button('Copy claim code',copy_claim)
    revoke_button=button('Revoke claim code',lambda:claim_action(True))
    claim_controls()
    state_label=ttk.Label(panel,textvariable=status,style='Setup.TLabel',wraplength=640,justify='left')
    state_label.pack(fill='x',pady=(8,12));labels.append(state_label)
    text('Keep people out of the setup preview when confirming the background. Close preview before starting monitoring. '
         'A saved outline always needs confirmation after reopening the camera. Camera numbers may change after reconnecting hardware; check the actual image.')
    text('Calibration status appears on the live image: verified, unconfirmed, occluded or view changed. '
         'Use a different view profile for a different angle. Bed areas never permanently disable fall monitoring.')
    text('No cloud credentials are displayed or edited. Device registration must be completed locally first. Existing managers can invite family from Manage family on the website. Closing setup hides a claim code but does not revoke it; use Revoke claim code or wait for expiry. Starting preview or monitoring also hides it.')
    def poll():
        nonlocal claim_pending,claim_deadline,home_pending,home_device,camera_pending
        try:
            device,code=home_results.get_nowait()
        except queue.Empty:pass
        else:
            home_pending=False;home_button.state(['!disabled'])
            try:matches=device==SettingsStore(root).device_id==store.device_id
            except Exception:matches=False
            home_device=device if matches and code else ''
            caption=(code['home_code']+' · '+code['home_name']) if isinstance(code,dict) else code
            home_label.configure(text=caption if home_device else 'Home ID unavailable — check this device’s connection and registration, then refresh.')
        if home_device:
            try:matches=home_device==SettingsStore(root).device_id
            except Exception:matches=False
            if not matches:
                home_device='';home_label.configure(text='Home ID unavailable — device identity changed. Reopen setup.')
        try:
            device,error=camera_results.get_nowait()
        except queue.Empty:pass
        else:
            camera_pending=False;busy(launcher.running)
            try:matches=device==SettingsStore(root).device_id==store.device_id
            except Exception:matches=False
            refresh_camera_list();refresh_home()
            status.set('Device identity changed. Reopen Camera setup.' if not matches else error or 'Camera setup saved. Family members see linked cameras automatically. Start monitoring when ready.')
        try:
            device,revoke,deadline,result,error=claim_results.get_nowait()
        except queue.Empty:pass
        else:
            claim_pending=False
            try:identity_matches=SettingsStore(root).device_id==device==store.device_id
            except Exception:identity_matches=False
            if not identity_matches:
                clear_claim();status.set('Device identity changed. Reopen Camera setup. The previous device code remains valid until revoked or expired.')
            elif error:status.set(error)
            elif revoke:
                clear_claim();claim_info.configure(text='Claim code revoked or already consumed.');status.set('No pending claim code remains from this request.')
            elif time.monotonic()<deadline:
                claim_code.set(result);claim_deadline=deadline
                claim_info.configure(text='One-use claim code shown once. Expires within 10 minutes. Generating another invalidates this code.')
                status.set('Sign in to the family website → Set up a monitoring device → Become device manager. No camera connection has been started.')
            else:status.set('Claim code expired during the request. Generate a new code.')
            busy(launcher.running)
        if claim_code.get():
            try:identity_matches=SettingsStore(root).device_id==store.device_id
            except Exception:identity_matches=False
            if time.monotonic()>=claim_deadline or not identity_matches:
                clear_claim();claim_info.configure(text='Code hidden: expired or device identity changed. Reopen setup if the device changed.')
        if launcher.running and launcher.mode=='scan' and time.monotonic()>launcher.scan_deadline:
            launcher.stop_setup();status.set('Camera scan timed out. Enter an index and try preview, or check camera permissions.')
        if launcher.process is not None and not launcher.running:
            proc=launcher.process;mode=launcher.mode;launcher.process=None
            if mode=='scan':
                out,_=proc.communicate()
                try:
                    found=json.loads(out)['available']
                    if not isinstance(found,list) or any(type(i)!=int or not 0<=i<=9 for i in found):raise ValueError()
                    camera.configure(values=[str(i) for i in found])
                    status.set('Available cameras: '+', '.join(map(str,found))+'. Select one and preview to identify it.' if found
                        else 'No usable cameras found at indices 0–9. Check access, or enter another index up to 31.')
                except (ValueError,KeyError,TypeError):status.set('Camera scan could not complete. Check camera access or try an index manually.')
            else:
                describe(store.current())
                status.set('Preview closed. Start monitoring to use these settings; confirm the bed on the new live view.' if mode=='preview' and proc.returncode==0
                    else f'{"Preview" if mode=="preview" else "Monitoring"} process ended (exit code {proc.returncode}). Check camera access if no live window appeared.')
            busy(False)
        window.after(300,poll)
    def close():
        if launcher.running and launcher.mode=='monitor':
            messagebox.showinfo('Monitoring stays running','Use Q in the live window to stop detection. Closing setup does not stop local alerts.',parent=window)
        else:launcher.stop_setup()
        clear_claim();pairing_entry.delete(0,'end')
        window.destroy()
    def resize(event):
        for item in labels:item.configure(wraplength=max(400,event.width-48))
        canvas.configure(scrollregion=canvas.bbox('all'))
    camera.bind('<<ComboboxSelected>>',load_selected)
    panel.bind('<Configure>',resize)
    canvas.bind('<Configure>',lambda event:canvas.itemconfigure(panel_id,width=event.width))
    window.bind('<MouseWheel>',lambda event:canvas.yview_scroll(int(-event.delta/120),'units'))
    for widget in fields+actions+[close_button,home_button]:
        widget.bind('<FocusIn>',lambda event:canvas.yview_moveto(max(0,(event.widget.winfo_y()-20)/max(1,panel.winfo_height()))))
    window.protocol('WM_DELETE_WINDOW',close)
    if store.device_id:window.after(0,refresh_home)
    window.after(300,poll);window.mainloop();return 0
