/**
 * First module evaluated by src/main.jsx (Rituals fork): moves a `/space#t=`
 * ticket into memory + sessionStorage and rewrites the address bar to a bare
 * `/space` before the router, the service worker registration or any other
 * module reads the location. Later tickets delivered to a running page
 * (fragment-only navigations) are caught by the listener.
 */
import { captureSpaceTicketFromLocation, installSpaceTicketListener } from './ritualsSpace';

captureSpaceTicketFromLocation();
installSpaceTicketListener();
