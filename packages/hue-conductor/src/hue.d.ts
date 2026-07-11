// Minimal ambient declaration for node-hue-api v4 (ships no types).
// Covers only the surface the Bridge Adapter uses. Extend as needed.
declare module "node-hue-api" {
  export interface LightState {
    on(): LightState;
    off(): LightState;
    rgb(r: number, g: number, b: number): LightState;
    xy(x: number, y: number): LightState;
    brightness(percent: number): LightState;
    transitionInMillis(ms: number): LightState;
  }

  export interface HueGroup {
    id: string | number;
    name: string;
    type: string; // "Room" | "Zone" | "LightGroup" | "Entertainment" | ...
    lights?: Array<string | number>;
  }

  export interface HueLight {
    id: string | number;
    name: string;
    type: string;
  }

  export interface HueApi {
    users: {
      createUser(
        appName: string,
        deviceName: string,
      ): Promise<{ username: string; clientkey?: string }>;
    };
    configuration: {
      getConfiguration(): Promise<{ bridgeid?: string; name?: string }>;
    };
    groups: {
      getAll(): Promise<HueGroup[]>;
      getGroup(id: string | number): Promise<HueGroup>;
    };
    lights: {
      getAll(): Promise<HueLight[]>;
      setLightState(id: string | number, state: LightState): Promise<boolean>;
    };
  }

  export interface DiscoveredBridge {
    ipaddress: string;
    id?: string;
    config?: { name?: string; bridgeid?: string };
  }

  interface LocalBootstrap {
    connect(username?: string): Promise<HueApi>;
  }

  interface HueModule {
    v3: {
      discovery: {
        nupnpSearch(): Promise<DiscoveredBridge[]>;
        upnpSearch(timeoutMs?: number): Promise<DiscoveredBridge[]>;
      };
      api: {
        createLocal(host: string): LocalBootstrap;
      };
      lightStates: {
        LightState: new () => LightState;
      };
    };
    ApiError: new (...args: unknown[]) => Error & { getHueErrorType(): number };
  }

  const hue: HueModule;
  export default hue;
}
