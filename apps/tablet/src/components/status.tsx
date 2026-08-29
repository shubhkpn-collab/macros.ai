import React from 'react';
import { Text, View } from 'react-native';
import {
  color, radius, space, type,
  type IdentityView, type OfflineView,
} from '@macros/tablet-view-model';

/**
 * Product presence and active identity.
 *
 * MACROS is present as a restrained wordmark rather than a logo — on a
 * dedicated appliance the brand is the device, so the screen does not need to
 * shout it. On a shared appliance, "whose food is this?" must never be
 * ambiguous, so the active user sits beside it.
 */
export function TopIdentityBar(
  { identity, children }: { identity: IdentityView; children?: React.ReactNode },
): React.JSX.Element {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.md,
    }}>
      <View accessible accessibilityLabel={`MACROS. Active user: ${identity.displayName}`}>
        <Text style={{
          color: color.textMuted, fontSize: type.productLabel.size,
          fontWeight: type.productLabel.weight, letterSpacing: type.productLabel.tracking,
        }}>
          MACROS
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xxs }}>
          <Text style={{ color: color.textPrimary, fontSize: type.metric.size, fontWeight: '600' }}>
            {identity.displayName}
          </Text>
          {identity.switchPending && identity.pendingTargetName !== null ? (
            // A stays active and stays named while B authenticates.
            <View style={{
              paddingHorizontal: space.md, paddingVertical: space.xxs,
              borderRadius: radius.pill, borderWidth: 1, borderColor: color.warning,
            }}>
              <Text style={{ color: color.warning, fontSize: type.caption.size }}>
                Switching to {identity.pendingTargetName}…
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {children}
    </View>
  );
}

/**
 * Offline status.
 *
 * The wording never claims server persistence for something only queued —
 * "waiting to sync" is the honest phrasing and the one the offline domain
 * actually supports.
 */
export function OfflineStatus({ offline }: { offline: OfflineView }): React.JSX.Element | null {
  if (offline.message === null) return null;
  return (
    <View
      accessible
      accessibilityLabel={offline.message}
      style={{
        alignSelf: 'flex-start',
        backgroundColor: color.surfaceMuted,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: offline.canLog ? color.border : color.danger,
        paddingHorizontal: space.md, paddingVertical: space.xs,
        flexDirection: 'row', alignItems: 'center', gap: space.sm,
      }}
    >
      <View style={{
        width: 10, height: 10, borderRadius: radius.pill,
        backgroundColor: offline.canLog ? color.offline : color.danger,
      }} />
      <Text style={{ color: color.textSecondary, fontSize: type.caption.size }}>
        {offline.message}
      </Text>
    </View>
  );
}

export function RecentFoodRow(
  { name, displayKcal }: { name: string; displayKcal: string },
): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`${name}, ${displayKcal} calories`}
      style={{
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingVertical: space.md,
        borderBottomWidth: 1, borderBottomColor: color.border,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: color.textPrimary, fontSize: type.body.size, flex: 1 }}
      >
        {name}
      </Text>
      <Text style={{ color: color.textSecondary, fontSize: type.body.size }}>
        {displayKcal} kcal
      </Text>
    </View>
  );
}

/**
 * Development banner.
 *
 * Unobtrusive but unmistakable: a fixture build must never be mistaken for
 * production, and a thin bar reads as a build stripe rather than product chrome.
 */
export function DevelopmentBanner({ notice }: { notice: string }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={notice}
      style={{
        backgroundColor: color.warning,
        paddingVertical: space.xxs,
        alignItems: 'center',
      }}
    >
      <Text style={{
        color: color.canvas, fontSize: 13, fontWeight: '700', letterSpacing: 1.2,
      }}>
        {notice}
      </Text>
    </View>
  );
}
