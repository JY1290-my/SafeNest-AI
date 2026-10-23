"""Authenticated on-demand WebRTC publisher. No webcam capture, recording, or frame queue."""
import asyncio
import os
import threading
import time


class VideoPublisher:
    def __init__(self,state):
        self.state=state
        self.stop_event=threading.Event()
        self.thread=None
        self.endpoint=os.getenv('SUPABASE_URL','').rstrip('/')+'/functions/v1/device-video-token'
        self.key=os.getenv('SUPABASE_PUBLISHABLE_KEY','')
        self.device=os.getenv('SAFENEST_DEVICE_ID','').lower()
        self.token=os.getenv('SAFENEST_DEVICE_TOKEN','')
        self.camera=os.getenv('SAFENEST_CAMERA_ID','')
        self.enabled=os.getenv('SAFENEST_VIDEO_ENABLED')=='1' and not state.demo
        if self.enabled and (not self.endpoint.startswith('https://') or not self.key or not self.device or len(self.token)<32):
            self.enabled=False
            print('Video disabled: configure Supabase URL, public key and device credentials.')
        self.allowed=set()
        self.authorized_until=0
        self.room=None
        self.publication=None
        self.source=None
        self.dimensions=None
        self.last_frame_at=0

    def start(self):
        if self.enabled:
            self.state.video_state='Connecting'
            self.thread=threading.Thread(target=self._thread_main,daemon=True,name='video-publisher')
            self.thread.start()

    def _thread_main(self):
        try:
            asyncio.run(self._run())
        except Exception:
            # Never surface credentials or kill the local detector because video failed.
            self.state.video_state='Camera stream not connected'
            self.state.clear_remote_lease()
            print('Remote video unavailable. Local detection and alarm remain active.')

    def _call(self,session,action):
        response=session.post(self.endpoint,headers={'apikey':self.key,'Content-Type':'application/json'},
            json={'device_id':self.device,'device_token':self.token,'action':action,**({'camera_id':self.camera} if self.camera else {})},
            timeout=(2,3),allow_redirects=False)
        if response.status_code!=200:raise RuntimeError('Video authorization rejected')
        return response.json()

    def viewers(self,now=None):
        now=time.monotonic() if now is None else now
        if self.room is None or now>=self.authorized_until:
            return set()
        return self.allowed.intersection(self.room.remote_participants.keys())

    async def _run(self):
        import requests
        from livekit import rtc
        with requests.Session() as session:
            while not self.stop_event.is_set():
                pump=None
                try:
                    credentials=await asyncio.to_thread(self._call,session,'issue')
                    if not credentials.get('server_url','').startswith('wss://'):raise RuntimeError('WSS required')
                    self.room=rtc.Room()
                    await asyncio.wait_for(self.room.connect(credentials['server_url'],credentials['token'],
                        rtc.RoomOptions(auto_subscribe=False)),timeout=15)
                    self.room.local_participant.set_track_subscription_permissions(allow_all_participants=False,participant_permissions=[])
                    self.state.video_state='Ready · no viewers'
                    pump=asyncio.create_task(self._pump(rtc))
                    while not self.stop_event.is_set() and self.room.isconnected():
                        if pump.done():await pump
                        try:
                            result=await asyncio.to_thread(self._call,session,'sync')
                            viewers=result.get('viewers')
                            if not isinstance(viewers,list) or len(viewers)>12 or any(not isinstance(v,str) or not v.startswith('family-') for v in viewers):
                                raise RuntimeError('Invalid authorization list')
                            self.allowed=set(viewers)
                            self.authorized_until=time.monotonic()+min(5,max(0,float(result.get('valid_for_seconds',0))))
                            permissions=[rtc.ParticipantTrackPermission(participant_identity=v,allow_all=True) for v in self.allowed]
                            self.room.local_participant.set_track_subscription_permissions(allow_all_participants=False,participant_permissions=permissions)
                        except Exception:
                            self.allowed=set();self.authorized_until=0
                            self.room.local_participant.set_track_subscription_permissions(allow_all_participants=False,participant_permissions=[])
                            self.state.video_state='Camera stream not connected'
                        for _ in range(30):
                            if self.stop_event.is_set() or not self.room.isconnected():break
                            await asyncio.sleep(.1)
                except Exception:
                    self.state.video_state='Camera stream not connected'
                finally:
                    self.allowed=set();self.authorized_until=0;self.state.clear_remote_lease()
                    if pump:
                        pump.cancel()
                        try:await pump
                        except (asyncio.CancelledError,Exception):pass
                    await self._unpublish()
                    if self.room:
                        try:await asyncio.wait_for(self.room.disconnect(),timeout=3)
                        except Exception:pass
                    self.room=None
                for _ in range(50):
                    if self.stop_event.is_set():break
                    await asyncio.sleep(.1)

    async def _unpublish(self):
        if self.publication and self.room:
            publication,self.publication=self.publication,None
            try:await asyncio.wait_for(self.room.local_participant.unpublish_track(publication.sid),timeout=2)
            except Exception:pass
        self.source=None;self.dimensions=None;self.last_frame_at=0

    async def _pump(self,rtc):
        import cv2
        while not self.stop_event.is_set():
            if not self.viewers() or not self.room.isconnected():
                self.state.clear_remote_lease()
                await self._unpublish()
                if self.authorized_until>time.monotonic():self.state.video_state='Ready · no viewers'
            else:
                item=self.state.remote_frame()
                if item is None:
                    await self._unpublish()
                    self.state.video_state='Camera stream not connected'
                else:
                    frame,frame_at=item
                    if frame_at!=self.last_frame_at:
                        h,w=frame.shape[:2]
                        width=max(2,min(w,640)//2*2);height=max(2,round(h*width/w)//2*2)
                        dimensions=(width,height)
                        if self.dimensions!=dimensions:
                            await self._unpublish()
                            self.source=rtc.VideoSource(width,height)
                            track=rtc.LocalVideoTrack.create_video_track('safenest-camera',self.source)
                            options=rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA,simulcast=False,
                                video_encoding=rtc.VideoEncoding(max_bitrate=500000,max_framerate=10))
                            self.publication=await self.room.local_participant.publish_track(track,options)
                            self.dimensions=dimensions
                        # Re-check auth/freshness after an awaited publish operation.
                        if self.viewers() and time.monotonic()-frame_at<2:
                            small=cv2.resize(frame,dimensions)
                            rgb=cv2.cvtColor(small,cv2.COLOR_BGR2RGB)
                            self.source.capture_frame(rtc.VideoFrame(width,height,rtc.VideoBufferType.RGB24,rgb.tobytes()))
                            self.last_frame_at=frame_at
                            self.state.video_state='Streaming'
            await asyncio.sleep(.1)

    def close(self):
        self.stop_event.set();self.state.clear_remote_lease()
        if self.thread:self.thread.join(timeout=4)
        self.state.video_state='Camera stream not connected'
