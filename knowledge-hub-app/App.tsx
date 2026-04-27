/**
 * Personal Knowledge Hub — React Native app entry point.
 */

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { ApiClientProvider } from './src/services/ApiClientContext';

const App: React.FC = () => {
  return (
    <SafeAreaProvider>
      <ApiClientProvider>
        <AppNavigator />
      </ApiClientProvider>
    </SafeAreaProvider>
  );
};

export default App;
