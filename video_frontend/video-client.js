import {Room,RoomEvent,Track} from 'livekit-client';
import {CameraController} from './camera-controller.js';
export function createRemoteCamera(options){
  return new CameraController({...options,createRoom:()=>new Room({adaptiveStream:false,dynacast:false}),events:RoomEvent,cameraSource:Track.Source.Camera});
}
