declare module "*/novnc/rfb.js" {
  interface RFBOptions {
    shared?: boolean;
    credentials?: { password?: string; username?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }

  class RFB {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RFBOptions,
    );

    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    showDotCursor: boolean;

    disconnect(): void;
    sendCredentials(credentials: {
      password?: string;
      username?: string;
      target?: string;
    }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;

    addEventListener(type: string, listener: (e: CustomEvent) => void): void;
    removeEventListener(type: string, listener: (e: CustomEvent) => void): void;
  }

  export default RFB;
}
