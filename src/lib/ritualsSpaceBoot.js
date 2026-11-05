/**
 * First module evaluated by src/main.jsx (Rituals fork): moves a `/space#t=`
 * ticket into memory + sessionStorage and rewrites the address bar to a bare
 * `/space` before the router, the service worker registration or any other
 * module reads the location. Later tickets delivered to a running page
 * (fragment-only navigations) are caught by the listener. In the Rituals hub's
 * frame, the router's page changes replace the frame's address instead of
 * adding history steps (installEmbeddedHistory), and the parent's messages
 * (visible, escape) are accepted from the Rituals origin only. The frame host
 * opened top-level (not framed by rituals.app) keeps nothing.
 */
import {
  captureSpaceTicketFromLocation,
  installEmbeddedHistory,
  installRitualsParentListener,
  installSpaceTicketListener,
} from './ritualsSpace';
import { isFrameHostTopLevel } from './ritualsSpaceInstance';

if (isFrameHostTopLevel()) {
  // The frame host outside its frame never boots (src/main.jsx): drop any
  // fragment from the address bar without reading or storing it.
  try {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // Nothing kept either way.
  }
} else {
  captureSpaceTicketFromLocation();
  installSpaceTicketListener();
  installEmbeddedHistory();
  installRitualsParentListener();
}
