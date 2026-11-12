/// <reference types="vite/client" />

/** Production build id, compared with the deployed /version.json to offer an update. */
declare const __APP_BUILD_ID__: string;

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
