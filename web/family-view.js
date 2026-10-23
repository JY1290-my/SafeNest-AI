// Display helpers never grant device access or mutate stored events.
export function displayName(value) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const identifier = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  return name && !name.includes('@') && !identifier.test(name) ? name.slice(0,80) : 'Family member';
}
export function recentEvents(events) {
  const timestamp = event => {
    const time = Date.parse(event?.time);
    return Number.isFinite(time) ? time : -Infinity;
  };
  return (Array.isArray(events) ? events : []).filter(event => event && typeof event === 'object')
    .slice().sort((a,b) => timestamp(b)-timestamp(a)).slice(0,10);
}
