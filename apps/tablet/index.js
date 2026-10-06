/**
 * React Native entry point.
 *
 * The composition root is built HERE — on the device, where the real adapters
 * live — and handed to `App` as props. Registering `App` bare would crash on
 * destructuring, because it requires a composition and an auth host.
 *
 * `createTabletHost` is resolved from the native bootstrap. Until the
 * production host exists, a development host is used and the shell displays a
 * permanent banner saying so.
 */
import React, { useEffect, useState } from 'react';
import { AppRegistry, Text, View } from 'react-native';
import { App } from './src/App';
import { name as appName } from './app.json';

function Root() {
  const [host, setHost] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Which host this resolves to is decided by Metro at BUILD time:
        // `npm run android` gets synthetic, the acceptance command gets remote.
        // Replace with the production TabletHostFactory when repositories,
        // credentials and hardware adapters are available on device.
        const { createSelectedHost } = await import('./src/host-selection');
        const built = await createSelectedHost();
        if (!cancelled) setHost(built);
      } catch (e) {
        if (!cancelled) {
          // Diagnostics go to the log, never to the screen. A stack trace or a
          // localhost URL in front of an investor is worse than any outage.
          console.error('[macros] host start failed', e);
          setError(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error !== null) {
    // Branded and generic. It says what happened and what to do, and nothing
    // about databases, providers or hosts.
    return (
      <View
        style={{
          flex: 1, backgroundColor: '#0C0F11', padding: 48,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Text style={{ color: '#F2F4F5', fontSize: 40, fontWeight: '600' }}>
          Hey! Macros
        </Text>
        <Text
          style={{
            color: '#A6ADB4', fontSize: 20, marginTop: 24, textAlign: 'center',
          }}
        >
          Something didn't start correctly.
        </Text>
        <Text style={{ color: '#6E767D', fontSize: 18, marginTop: 8 }}>
          Try again.
        </Text>
      </View>
    );
  }
  if (host === null) {
    return <View style={{ flex: 1, backgroundColor: '#0E1113' }} />;
  }

  return (
    <App
      composition={host.composition}
      auth={host.auth}
      hasActiveSession={host.hasActiveSession}
      developmentNotice={host.developmentNotice}
      guidance={host.guidance}
      premiumSpeech={host.premiumSpeech}
    />
  );
}

AppRegistry.registerComponent(appName, () => Root);
