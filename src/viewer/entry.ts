import { quickSwitching, sessionHost } from './session';
import { hostViewers } from './switchHost';

// With quick switching on, the page holds the viewers, each a frame showing this page again with
// ?viewer (see switchHost.ts); otherwise, and in such a frame, the page is the viewer itself.
if (quickSwitching() && !sessionHost() && !new URLSearchParams(location.search).has('viewer')) hostViewers();
else void import('./main');
