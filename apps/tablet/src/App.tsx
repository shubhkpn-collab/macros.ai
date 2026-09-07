import React, { useCallback, useMemo, useState } from 'react';
import { SafeAreaView, StatusBar } from 'react-native';
import { color } from '@macros/tablet-view-model';
import { TabletShell } from './components/screens.js';
import { createActions, type AuthHostPort } from './actions.js';
import { renderModel, type TabletComposition } from './composition.js';

/**
 * Root component.
 *
 * It owns no domain state: after every interaction it re-projects the view
 * model, so the screen is a projection of the application rather than a second
 * copy that could drift from it.
 */
export function App(
  { composition, auth, hasActiveSession, developmentNotice = null, guidance }:
  {
    composition: TabletComposition; auth: AuthHostPort;
    hasActiveSession: boolean; developmentNotice?: string | null;
    guidance?: Parameters<typeof createActions>[0]['guidance'];
  },
): React.JSX.Element {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const vm = useMemo(
    () => renderModel(composition, hasActiveSession),
    // `tick` re-projects after an interaction; it carries no data itself.
    [composition, hasActiveSession, tick],
  );

  const actions = useMemo(() => createActions({
    controller: composition.controller,
    ...(guidance !== undefined ? { guidance } : {}),
    auth,
    activity: () => composition.currentActivity(),
    onChanged: refresh,
  }), [composition, auth, guidance, refresh]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.canvas }}>
      <StatusBar barStyle="light-content" backgroundColor={color.canvas} />
      <TabletShell vm={vm} actions={actions} developmentNotice={developmentNotice} />
    </SafeAreaView>
  );
}
