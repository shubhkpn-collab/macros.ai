import React from 'react';
import { Text, View } from 'react-native';
import {
  color, radius, space, type,
  type IdentityView, type OfflineView,
} from '@macros/tablet-view-model';

/**
 * Active identity. Small but unmistakable — on a shared appliance, "whose food
 * is this?" must never be ambiguous.
 */
export function TopIdentityBar(
  { identity, children }: { identity: IdentityView; children?: React.ReactNode },
): React.JSX.Element {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: space.xl, paddingVertical: space.md,
    }}>
      <View accessible accessibilityLabel={`Active user: ${identity.displayName}`}>
        <Text style={{ color: color.textPrimary, fontSize: type.title.size, fontWeight: '600' }}>
          {identity.displayName}
        </Text>
        {identity.switchPending && identity.pendingTargetName !== null ? (
          // A stays active and stays named while B authenticates.
          <Text style={{ color: color.warning, fontSize: type.caption.size }}>
            Switching to {identity.pendingTargetName}…
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/**
 * Offline status.
 *
 * The wording never claims server persistence for something that has only been
 * queued — "waiting to sync" is the honest phrasing and the one the offline
 * domain actually supports.
 */
export function OfflineStatus({ offline }: { offline: OfflineView }): React.JSX.Element | null {
  if (offline.message === null) return null;
  return (
    <View
      accessible
      accessibilityLabel={offline.message}
      style={{
        backgroundColor: color.surfaceOverlay, borderRadius: radius.md,
        paddingHorizontal: space.lg, paddingVertical: space.sm,
        flexDirection: 'row', alignItems: 'center', gap: space.sm,
      }}
    >
      <View style={{
        width: 12, height: 12, borderRadius: radius.pill,
        backgroundColor: offline.canLog ? color.offline : color.danger,
      }} />
      <Text style={{ color: color.textSecondary, fontSize: type.label.size }}>
        {offline.message}
      </Text>
    </View>
  );
}

export function RecentFoodRow(
  { name, kcal }: { name: string; kcal: number },
): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`${name}, ${kcal} calories`}
      style={{
        flexDirection: 'row', justifyContent: 'space-between',
        paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.surfaceHairline,
      }}
    >
      <Text style={{ color: color.textPrimary, fontSize: type.body.size }} numberOfLines={1}>
        {name}
      </Text>
      <Text style={{ color: color.textSecondary, fontSize: type.body.size }}>{kcal} kcal</Text>
    </View>
  );
}
