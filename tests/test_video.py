import asyncio
import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import AsyncMock,Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from monitor_bridge import MonitorState
from video_publisher import VideoPublisher

class VideoTests(unittest.TestCase):
    def test_latest_frame_and_separate_leases(self):
        state=MonitorState();a=object();b=object()
        state.remote_frame();state.update('Normal',True,(0,.5,None),a)
        self.assertIs(state.remote_frame()[0],a)
        state.update('Normal',True,(0,.5,None),b)
        self.assertIs(state.remote_frame()[0],b)
        self.assertIsNone(state.snapshot()['features'][2])
        self.assertNotIn('frame',state.snapshot())
        state.frame_requested_until=time.monotonic()+5
        state.clear_remote_lease();self.assertIsNotNone(state.frame)
        state.frame_requested_until=0;state.clear_remote_lease();self.assertIsNone(state.frame)

    def test_stale_and_offline_frame_never_sent(self):
        state=MonitorState();state.remote_frame();state.update('Normal',True,frame=object())
        state.frame_at-=3;self.assertIsNone(state.remote_frame())
        state.update('Camera Offline',False);self.assertIsNone(state.remote_frame())

    def test_only_current_authorized_present_viewers(self):
        p=VideoPublisher(MonitorState());p.room=types.SimpleNamespace(remote_participants={'family-ok':1,'family-rogue':1})
        p.allowed={'family-ok'};p.authorized_until=time.monotonic()+5
        self.assertEqual(p.viewers(),{'family-ok'})
        self.assertEqual(p.viewers(p.authorized_until+1),set())
        p.room.remote_participants={};self.assertEqual(p.viewers(),set())

    def test_demo_disables_remote_video(self):
        with patch.dict(os.environ,{'SAFENEST_VIDEO_ENABLED':'1','SUPABASE_URL':'https://test.supabase.co','SUPABASE_PUBLISHABLE_KEY':'public','SAFENEST_DEVICE_ID':'test','SAFENEST_DEVICE_TOKEN':'x'*40}):
            self.assertFalse(VideoPublisher(MonitorState(demo=True)).enabled)

class PumpTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_rtc_frame_format_and_no_encoding_without_viewers(self):
        import numpy as np
        from livekit import rtc
        state=MonitorState();p=VideoPublisher(state)
        local=types.SimpleNamespace(unpublish_track=AsyncMock(),publish_track=AsyncMock(return_value=types.SimpleNamespace(sid='track')))
        p.room=types.SimpleNamespace(remote_participants={},isconnected=lambda:True,local_participant=local)
        source=Mock();fake_rtc=types.SimpleNamespace(VideoSource=Mock(return_value=source),LocalVideoTrack=types.SimpleNamespace(create_video_track=Mock()),TrackPublishOptions=rtc.TrackPublishOptions,TrackSource=rtc.TrackSource,VideoEncoding=rtc.VideoEncoding,VideoBufferType=rtc.VideoBufferType,VideoFrame=rtc.VideoFrame)
        task=asyncio.create_task(p._pump(fake_rtc))
        try:
            await asyncio.sleep(.12)
            fake_rtc.VideoSource.assert_not_called()
            p.room.remote_participants={'family-ok':1};p.allowed={'family-ok'};p.authorized_until=time.monotonic()+5
            # Start remote lease, then let the original capture path supply the frame.
            state.remote_frame();state.update('Normal',True,frame=np.zeros((480,800,3),dtype=np.uint8))
            await asyncio.sleep(.15)
            fake_rtc.VideoSource.assert_called_once_with(640,384)
            self.assertEqual(source.capture_frame.call_count,1)
            video=source.capture_frame.call_args.args[0]
            self.assertEqual(video.width,640);self.assertEqual(video.height,384)
            await asyncio.sleep(.12)
            self.assertEqual(source.capture_frame.call_count,1) # Never resend same captured frame.
            p.authorized_until=0
            await asyncio.sleep(.12)
            local.unpublish_track.assert_awaited_with('track')
            self.assertIsNone(state.frame)
        finally:
            p.stop_event.set();await task
