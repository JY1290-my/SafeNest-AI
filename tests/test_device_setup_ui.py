"""Exercise setup actions with a small Tk mock; no desktop or camera is opened."""
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from device_settings import SettingsStore
from device_setup_ui import run_ui


class Variable:
    def __init__(self, value=''):self.value=value
    def get(self):return self.value
    def set(self,value):self.value=value


class Widget:
    all=[]
    def __init__(self,*args,**kwargs):
        self.options=kwargs;self.disabled=False;self.protocols={};self.timers=[];self.bindings=[]
        Widget.all.append(self)
    def configure(self,**kwargs):self.options.update(kwargs)
    def state(self,states):self.disabled='disabled' in states
    def pack(self,**kwargs):pass
    def bind(self,*args):self.bindings.append(args[0])
    def yview(self,*args):pass
    def yview_scroll(self,*args):pass
    def yview_moveto(self,*args):pass
    def set(self,*args):pass
    def delete(self,*args):self.options["value"]=""
    def get(self):return self.options.get("value", "")
    def create_window(self,*args,**kwargs):return 1
    def itemconfigure(self,*args,**kwargs):pass
    def bbox(self,*args):return (0,0,600,1200)
    def title(self,*args):pass
    def geometry(self,*args):pass
    def minsize(self,*args):pass
    def mainloop(self):pass
    def after(self,delay,callback):self.timers.append(callback)
    def protocol(self,name,callback):self.protocols[name]=callback
    def destroy(self):self.closed=True
    def winfo_y(self):return 0
    def winfo_height(self):return 1200


class SetupUIActionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        env=patch.dict(os.environ,{},clear=True);env.start();self.addCleanup(env.stop)
        Widget.all=[]
        tk=types.ModuleType('tkinter');ttk=types.ModuleType('tkinter.ttk')
        tk.Tk=tk.Canvas=Widget;tk.StringVar=Variable
        for name in ('Frame','Label','Entry','Combobox','Scrollbar','Button'):setattr(ttk,name,type(name,(Widget,),{}))
        ttk.Style=lambda *args:Mock()
        tk.ttk=ttk;tk.messagebox=Mock()
        modules=patch.dict(sys.modules,{'tkinter':tk,'tkinter.ttk':ttk})
        modules.start();self.addCleanup(modules.stop)
        self.launcher=Mock(running=False,mode=None,process=None)
        run_ui(self.root,lambda root:self.launcher)

    def button(self,name):
        return next(w for w in Widget.all if type(w).__name__=='Button' and w.options.get('text')==name)

    def click(self,name):self.button(name).options['command']()

    def variables(self):
        return [w.options['textvariable'] for w in Widget.all if type(w).__name__ in ('Entry','Combobox') and 'textvariable' in w.options and w.options.get('state')!='readonly']

    def test_first_local_setup_saves_without_cloud_id_and_does_not_open_camera_automatically(self):
        self.launcher.preview.assert_not_called();self.launcher.start.assert_not_called();self.launcher.scan.assert_not_called()
        source,profile,room,name=self.variables()
        source.set('2');profile.set('bedroom');room.set('Bedroom');name.set('USB camera')
        self.click('Save device settings')
        value=SettingsStore(self.root).current()
        self.assertEqual((value.source,value.profile,value.room,value.camera_name),(2,'bedroom','Bedroom','USB camera'))
        self.assertTrue(value.scope.startswith('local-'))

    def test_typing_r_in_setup_text_fields_has_no_global_reset_shortcut(self):
        source,profile,room,name=self.variables()
        profile.set('Room_R');room.set('Room R');name.set('Camera R')
        self.assertFalse(any('Key' in binding or binding.lower()=='<r>'
                             for widget in Widget.all for binding in widget.bindings))
        self.click('Save device settings')
        saved=SettingsStore(self.root).current()
        self.assertEqual((saved.profile,saved.room,saved.camera_name),('Room_R','Room R','Camera R'))

    def test_preview_is_explicit_saves_selected_camera_and_disables_editing(self):
        source,profile,room,name=self.variables();source.set('3');profile.set('side')
        self.click('Preview & calibrate')
        self.launcher.preview.assert_called_once();self.launcher.start.assert_not_called()
        self.assertEqual(SettingsStore(self.root).current().source,3)
        self.assertTrue(self.button('Save device settings').disabled)

    def test_device_identity_change_blocks_stale_setup_save_and_preview(self):
        before=(self.root/'device_settings.json').read_bytes()
        os.environ['SAFENEST_DEVICE_ID']='11111111-1111-4111-8111-111111111111'
        self.click('Preview & calibrate')
        self.launcher.preview.assert_not_called()
        self.assertEqual((self.root/'device_settings.json').read_bytes(),before)
        messages=[w.options['textvariable'].get() for w in Widget.all if 'textvariable' in w.options]
        self.assertTrue(any('Device identity changed' in str(message) for message in messages))

    def test_closing_setup_does_not_stop_monitoring_or_local_alerts(self):
        self.launcher.running=True;self.launcher.mode='monitor'
        window=Widget.all[0];window.protocols['WM_DELETE_WINDOW']()
        self.launcher.stop_setup.assert_not_called();self.assertTrue(window.closed)

    def registered_setup(self):
        os.environ['SAFENEST_DEVICE_ID']='10000000-0000-4000-8000-000000000001'
        Widget.all=[]
        run_ui(self.root,lambda root:self.launcher)

    def claim_value(self):
        return next(w.options['textvariable'] for w in Widget.all if w.options.get('state')=='readonly')

    def tick(self):Widget.all[0].timers[-1]()

    def synchronous_thread(self,**kwargs):
        return Mock(start=lambda:kwargs['target']())

    def test_claim_requires_registered_device_and_never_issues_automatically(self):
        with patch('device_setup_ui.issue_claim') as issue:
            self.click('Generate device claim code');issue.assert_not_called()
            self.registered_setup();issue.assert_not_called()
        self.launcher.preview.assert_not_called();self.launcher.start.assert_not_called()
        self.assertTrue(self.button('Copy claim code').disabled)

    def test_claim_generate_show_revoke_and_close_clear_without_saving_code(self):
        self.registered_setup();code='sn-claim-'+'a'*32
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.issue_claim',return_value=code) as issue, patch('device_setup_ui.cancel_claim') as revoke:
            self.click('Generate device claim code');issue.assert_called_once()
            self.assertTrue(self.button('Generate device claim code').disabled)
            self.tick();self.assertEqual(self.claim_value().get(),code)
            self.assertFalse(self.button('Revoke claim code').disabled)
            self.assertNotIn(code,(self.root/'device_settings.json').read_text())
            self.click('Revoke claim code');self.tick();revoke.assert_called_once()
            self.assertEqual(self.claim_value().get(),'')
            self.click('Generate device claim code');self.tick()
            Widget.all[0].protocols['WM_DELETE_WINDOW']()
            self.assertEqual(self.claim_value().get(),'')
            self.assertEqual(revoke.call_count,1) # closing is not a promised server revocation

    def test_claim_safe_failure_and_identity_change_discard_response(self):
        self.registered_setup();code='sn-claim-'+'a'*32
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.issue_claim',side_effect=RuntimeError('DO-NOT-PRINT-SECRET')):
            self.click('Generate device claim code');self.tick()
            messages=[w.options['textvariable'].get() for w in Widget.all if 'textvariable' in w.options]
            self.assertNotIn('DO-NOT-PRINT-SECRET',str(messages));self.assertEqual(self.claim_value().get(),'')
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.issue_claim',return_value=code):
            self.click('Generate device claim code')
            os.environ['SAFENEST_DEVICE_ID']='10000000-0000-4000-8000-000000000002'
            self.tick();self.assertEqual(self.claim_value().get(),'')

    def test_claim_expires_and_preview_hides_code_without_changing_camera_behavior(self):
        self.registered_setup();code='sn-claim-'+'a'*32
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.issue_claim',return_value=code), patch('device_setup_ui.time.monotonic',return_value=100) as clock:
            self.click('Generate device claim code');self.tick();self.assertEqual(self.claim_value().get(),code)
            clock.return_value=701;self.tick();self.assertEqual(self.claim_value().get(),'')
            self.click('Generate device claim code');self.tick();self.assertEqual(self.claim_value().get(),code)
            self.click('Preview & calibrate');self.assertEqual(self.claim_value().get(),'')
            self.launcher.preview.assert_called_once()

    def home_label(self):
        return next(w for w in Widget.all if type(w).__name__=='Label' and w.options.get('text','').startswith(('Home ID','Checking Home','Home-')))

    def test_home_id_refresh_is_read_only_and_clears_on_identity_change(self):
        self.registered_setup()
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.read_home_code',return_value='Home-001') as read:
            self.click('Refresh Home ID');self.tick();read.assert_called_once()
            self.assertIn('Home-001',self.home_label().options['text'])
            self.launcher.start.assert_not_called();self.launcher.preview.assert_not_called()
            os.environ['SAFENEST_DEVICE_ID']='10000000-0000-4000-8000-000000000002'
            self.tick();self.assertIn('Home ID unavailable',self.home_label().options['text'])

    def test_home_id_failed_or_stale_lookup_never_reuses_another_device_label(self):
        self.registered_setup()
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.read_home_code',return_value='Home-002'):
            self.click('Refresh Home ID')
            os.environ['SAFENEST_DEVICE_ID']='10000000-0000-4000-8000-000000000002'
            self.tick();self.assertNotIn('Home-002',self.home_label().options['text'])
        os.environ['SAFENEST_DEVICE_ID']='10000000-0000-4000-8000-000000000001'
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread), patch('device_setup_ui.read_home_code',side_effect=RuntimeError('DO-NOT-SHOW-TOKEN')):
            self.click('Refresh Home ID');self.tick()
            self.assertIn('Home ID unavailable',self.home_label().options['text']);self.assertNotIn('TOKEN',self.home_label().options['text'])


if __name__=='__main__':unittest.main()


class MultiCameraSetupActionsTests(unittest.TestCase):
    setUp=SetupUIActionsTests.setUp
    registered_setup=SetupUIActionsTests.registered_setup
    button=SetupUIActionsTests.button
    click=SetupUIActionsTests.click
    tick=SetupUIActionsTests.tick
    synchronous_thread=SetupUIActionsTests.synchronous_thread

    def test_register_and_start_all_require_explicit_clicks(self):
        self.registered_setup()
        result={'ok':True,'device_id':os.environ['SAFENEST_DEVICE_ID'],'home_id':os.environ['SAFENEST_DEVICE_ID'],
                'home_code':'Home-001','camera_id':'30000000-0000-4000-8000-000000000001','is_default':True}
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread),patch('camera_catalog._request',return_value=result) as request,patch('device_setup_ui.read_home_code',return_value='Home-001'):
            request.assert_not_called();self.launcher.start_all.assert_not_called()
            self.click('Register selected camera to this Home');self.tick()
            self.assertTrue((self.root/'camera_sources.json').exists());self.launcher.start_all.assert_not_called()
            self.click('Start all registered cameras');self.launcher.start_all.assert_called_once()

    def test_pairing_code_is_cleared_and_never_saved_or_automatically_redeemed(self):
        self.registered_setup();code='sn-camera-'+'a'*32
        entry=next(w for w in Widget.all if type(w).__name__=='Entry' and w.options.get('show')=='•')
        entry.options['value']=code
        result={'ok':True,'device_id':os.environ['SAFENEST_DEVICE_ID'],'home_id':'10000000-0000-4000-8000-000000000002'}
        with patch('device_setup_ui.threading.Thread',side_effect=self.synchronous_thread),patch('camera_catalog._request',return_value=result) as request,patch('device_setup_ui.read_home_code',return_value='Home-001'):
            request.assert_not_called();self.click('Join Home with camera setup code');self.tick()
            self.assertEqual(request.call_args.args[2],'pair_camera_device');self.assertEqual(entry.get(),'')
            self.launcher.start.assert_not_called();self.launcher.preview.assert_not_called()
            self.assertNotIn(code,(self.root/'device_settings.json').read_text())
