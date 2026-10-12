import { mergeConfig } from 'vite';
import appConfig from '../vite.config';

export default mergeConfig(appConfig, {
  cacheDir: 'node_modules/.vite-browser-fixtures',
});
