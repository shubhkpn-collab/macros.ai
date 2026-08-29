import React, { useState } from 'react';
import { Image, ScrollView, Text, TextInput, View } from 'react-native';
import { color, radius, space, touch, type } from '@macros/tablet-view-model';
import type { FoodCardView } from '@macros/tablet-view-model';
import { PrimaryAction, SecondaryAction, SectionLabel } from './primitives.js';

/**
 * DEVELOPMENT-ONLY FOOD CARD BROWSER.
 *
 * A QA surface for inspecting real catalog results — NOT production navigation
 * and not a design milestone. It exists so catalog quality can be judged by
 * looking at it, which no metric fully substitutes for.
 *
 * It renders whatever the catalog actually holds, including gaps: a food with
 * no serving weight says so rather than hiding the hole.
 */
export function DevFoodCardBrowser(
  { cards, query, onSearch, onClose }:
  {
    cards: readonly FoodCardView[]; query: string;
    onSearch: (q: string) => void; onClose: () => void;
  },
): React.JSX.Element {
  const [text, setText] = useState(query);

  return (
    <View style={{ flex: 1, paddingHorizontal: space.xl }}>
      <View style={{ paddingTop: space.lg }}>
        <SectionLabel>Catalog QA · development only</SectionLabel>
        <TextInput
          accessibilityLabel="Catalog search query"
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => onSearch(text.trim())}
          returnKeyType="search"
          placeholder="Search the real catalog…"
          placeholderTextColor={color.textMuted}
          style={{
            minHeight: touch.fieldHeight, borderRadius: radius.md,
            backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
            color: color.textPrimary, fontSize: type.body.size,
            paddingHorizontal: space.lg, marginTop: space.md,
          }}
        />
      </View>

      <ScrollView style={{ flex: 1, marginTop: space.md }} showsVerticalScrollIndicator={false}>
        {cards.map((c) => (
          <View
            key={c.productVersionId}
            accessible
            accessibilityLabel={c.accessibilityLabel}
            style={{
              flexDirection: 'row', gap: space.md,
              backgroundColor: color.surface, borderRadius: radius.lg,
              borderWidth: 1, borderColor: color.border,
              padding: space.md, marginBottom: space.sm,
            }}
          >
            {/*
              IMAGE-READY. A real URL renders; otherwise the deterministic
              placeholder. Coverage is 0% today, so in practice every tile is a
              placeholder — but no code change is needed once images exist.
            */}
            {c.imageUrl !== null ? (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: c.imageUrl }}
                style={{ width: 84, height: 84, borderRadius: radius.md,
                  backgroundColor: color.surfaceMuted }}
              />
            ) : (
              <View style={{
                width: 84, height: 84, borderRadius: radius.md,
                backgroundColor: color.surfaceMuted,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Text style={{ color: color.textMuted, fontSize: 26, fontWeight: '700' }}>
                  {c.imageInitials}
                </Text>
              </View>
            )}

            <View style={{ flex: 1 }}>
              <Text numberOfLines={2} style={{ color: color.textPrimary, fontSize: type.body.size }}>
                {c.displayName}
              </Text>
              <Text style={{ color: color.textSecondary, fontSize: type.caption.size }}>
                {c.brandLine}
              </Text>
              <Text style={{ color: color.textMuted, fontSize: type.caption.size }}>
                {c.preparationLine} · {c.servingLine}
              </Text>
              <Text style={{
                color: c.displayable ? color.accent : color.warning,
                fontSize: type.caption.size, marginTop: space.xxs,
              }}>
                {c.nutritionLine}
              </Text>
              <Text style={{ color: color.textSecondary, fontSize: type.caption.size }}>
                {c.macroLine}
              </Text>
              {c.dataWarning !== null ? (
                // Gaps are shown, not hidden: that is the point of a QA surface.
                <Text style={{ color: color.warning, fontSize: type.caption.size,
                  marginTop: space.xxs }}>
                  {c.dataWarning}
                </Text>
              ) : null}
              {c.imageAttribution !== null ? (
                <Text style={{ color: color.textMuted, fontSize: 13 }}>
                  {c.imageAttribution}
                </Text>
              ) : null}
            </View>
          </View>
        ))}

        {cards.length === 0 ? (
          <Text style={{ color: color.textMuted, fontSize: type.body.size, marginTop: space.xl }}>
            No results
          </Text>
        ) : null}
      </ScrollView>

      <View style={{ gap: space.sm, paddingVertical: space.lg }}>
        <PrimaryAction
          label="Search catalog"
          accessibilityLabel="Search the catalog"
          onPress={() => onSearch(text.trim())}
        />
        <SecondaryAction label="Close" accessibilityLabel="Close the catalog browser" onPress={onClose} />
      </View>
    </View>
  );
}
