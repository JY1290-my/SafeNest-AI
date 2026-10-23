export const STALE_MS = 15000;
export const STATES = {
  Normal: ['normal', 'No fall condition detected in the current frame.'],
  Checking: ['warning', 'An unusual posture is being evaluated by the existing detector.'],
  'Suspected Fall': ['danger', 'Current observations suggest a possible fall. Please check the situation; injury is not confirmed.'],
  'No Person': ['warning', 'No person is visible. The camera cannot assess someone outside its view.'],
  'Multiple People': ['warning', 'Legacy multi-person status. Current posture assessment is unavailable.'],
  'Pose Unclear': ['warning', 'Body keypoints are unclear. Fall status cannot be assessed.'],
  'Check Person': ['warning', 'Posture or movement needs a family check. The cause is uncertain.'],
  'Tracking Lost': ['warning', 'A recently visible person cannot currently be tracked. This does not confirm recovery.'],
  'Resting in Bed': ['warning', 'Likely resting in the calibrated bed area. Monitoring continues; this is not confirmation of safety.'],
  Starting: ['offline', 'The laptop detector is starting.'],
  'Camera Offline': ['offline', 'The laptop could not open or read the camera.'],
  'AI Offline': ['offline', 'The detection process has stopped.'],
  'Connection Lost': ['offline', 'Current status is unavailable. The previous status is no longer current.']
};
export function currentStatus(data, elapsedMs = 0, failed = false) {
  const p = data?.payload;
  const server = Date.parse(data?.server_now), received = Date.parse(data?.received_at);
  const age = server - received + Math.max(0, elapsedMs);
  if (failed || !p || !Number.isFinite(age) || age < -1000 || age > STALE_MS || p.stale)
    return {status: 'Connection Lost', tone: 'offline', description: STATES['Connection Lost'][1], connected: false, age};
  let status = Object.hasOwn(STATES, p.status) ? p.status : 'Connection Lost';
  if (p.camera_connected !== true && !['Starting', 'AI Offline', 'Camera Offline', 'Connection Lost'].includes(status)) status = 'Camera Offline';
  const [tone, description] = STATES[status];
  return {status, tone, description, connected: p.camera_connected === true && tone !== 'offline', age};
}
