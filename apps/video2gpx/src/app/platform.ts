/** The platform of the web view: WebKit on the Mac, WebKitGTK on Linux (the browser preview reports the browser's). */
export const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

/** Label of the action that shows a file in the system's file browser. */
export const revealLabel = isMac ? "Im Finder zeigen" : "Im Dateimanager zeigen";

/** "diesem Mac" or "diesem Rechner", for texts about where things run or are installed. */
export const thisComputer = isMac ? "diesem Mac" : "diesem Rechner";
