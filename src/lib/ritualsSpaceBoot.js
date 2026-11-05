/**
 * First module evaluated by src/main.jsx (Rituals fork): moves a `/space#t=`
 * ticket into memory + sessionStorage and rewrites the address bar to a bare
 * `/space` before the router, the service worker registration or any other
 * module reads the location. Later tickets delivered to a running page
 * (fragment-only navigations) are caught by the listener. In the Rituals hub's
 * frame, the router's page changes replace the frame's address instead of
 * adding history steps (installEmbeddedHistory).
 */
import {
  captureSpaceTicketFromLocation,
  installEmbeddedHistory,
  installSpaceTicketListener,
} from './ritualsSpace';

captureSpaceTicketFromLocation();
installSpaceTicketListener();
installEmbeddedHistory();
