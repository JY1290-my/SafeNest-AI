import {bootDashboard} from './dashboard.js';
import {createRemoteCamera} from './video-client.js';
import {createFamilyPresence} from './presence-client.js';
bootDashboard({window,document,fetch:window.fetch.bind(window),createRemoteCamera,createFamilyPresence});
