import React, { useId } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Stop, Path, Rect, Ellipse, G } from 'react-native-svg';
import { referencePalette, color } from '@macros/tablet-view-model';

export type IconName = 'leaf' | 'mic' | 'search' | 'menu' | 'user' | 'home' | 'dashboard' | 'plus' | 'close' | 'edit' | 'check' | 'arrow';
const paths: Record<IconName, string> = {
  leaf: 'M12 21v-9 M12 16C3 16 2 9 4 5c6 0 9 4 8 11 M12 12C12 4 17 2 22 2c1 6-3 12-10 12',
  mic: 'M12 16a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v8a3 3 0 0 0 3 3 M5 11v2a7 7 0 0 0 14 0v-2 M12 20v3 M8 23h8',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  menu: 'M3 6h18 M3 12h18 M3 18h14',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 22v-3a8 8 0 0 1 16 0v3',
  home: 'M2 11l10-9 10 9 M5 9v13h14V9 M9 22v-8h6v8',
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  plus: 'M12 4v16 M4 12h16', close: 'M5 5l14 14 M5 19L19 5',
  edit: 'M4 16L16 4l4 4L8 20l-5 1z M14 6l4 4',
  check: 'M4 12l5 5L21 5', arrow: 'M9 5l7 7-7 7',
};
export function Icon({ name, size = 24, tint = color.textPrimary }: { name: IconName; size?: number; tint?: string }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d={paths[name]} fill="none" stroke={tint} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}
export function IconButton({ name, label, onPress, active = false }: { name: IconName; label: string; onPress: () => void; active?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed || active ? color.surfaceActive : 'transparent' })}><Icon name={name} /></Pressable>;
}
export function Ring({ label, value, goal, fraction, size = 104 }: { label: string; value: string; goal?: string | undefined; fraction: number | null; size?: number }) {
  const id = useId().replace(/:/g, '');
  const tint = label === 'Protein' ? color.macroProtein : label === 'Carbs' ? color.macroCarbs : label === 'Fat' ? color.macroFat : referencePalette.tone26;
  const r = 43; const length = 2 * Math.PI * r;
  return <View accessible accessibilityLabel={`${label}: ${value}${goal === undefined ? '' : ` of ${goal}`}`} style={{ alignItems: 'center', flex: 1, minWidth: 76 }}>
    <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
      <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={tint} /><Stop offset="1" stopColor={label === 'Calories' ? referencePalette.tone25 : tint} /></LinearGradient></Defs>
        <Circle cx="50" cy="50" r={r} fill="none" stroke={referencePalette.tone5} strokeWidth="7" />
        {fraction !== null && fraction > 0 ? <Circle cx="50" cy="50" r={r} fill="none" stroke={`url(#${id})`} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${length * fraction} ${length}`} rotation="-90" origin="50,50" /> : null}
      </Svg>
      <Text style={{ color: color.textPrimary, fontSize: size > 110 ? 28 : 23, fontWeight: '700', fontStyle: 'italic' }}>{value}</Text>
      {goal === undefined ? null : <Text style={{ color: color.textSecondary, fontSize: 13 }}>/ {goal}</Text>}
    </View>
    <Text style={{ color: color.textSecondary, fontSize: 15, marginTop: 9 }}>{label}</Text>
  </View>;
}
/** Original illustrations, not invented branded product photography. */
export function FoodArt({ name, size = 112 }: { name: string; size?: number }) {
  const oats = /oat|bread|rice/i.test(name); const green = /salad|brocc|sprout|veget/i.test(name);
  return <Svg width={size} height={size} viewBox="0 0 120 120">
    <Defs><LinearGradient id="pack" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={referencePalette.tone29} /><Stop offset="1" stopColor={referencePalette.tone22} /></LinearGradient></Defs>
    <Ellipse cx="60" cy="106" rx="41" ry="6" fill={referencePalette.tone0} opacity="0.25" />
    <Rect x="20" y="14" width="80" height="87" rx="8" fill="url(#pack)" stroke={referencePalette.tone17} strokeWidth="2" />
    <Rect x="26" y="20" width="68" height="24" rx="3" fill={green ? referencePalette.tone6 : oats ? referencePalette.tone15 : referencePalette.tone8} />
    <Path d="M30 35h20 M30 29h34" stroke={referencePalette.tone28} strokeWidth="3" strokeLinecap="round" />
    {oats ? <G fill={referencePalette.tone19} stroke={referencePalette.tone16} strokeWidth="1">{[0,1,2].map(i => <Rect key={i} x={34+i*9} y={54+i*6} width="32" height="29" rx="7" />)}</G> : green ? <G fill={referencePalette.tone10}><Ellipse cx="50" cy="66" rx="16" ry="10" rotation="-30" origin="50,66" /><Ellipse cx="73" cy="76" rx="17" ry="9" rotation="35" origin="73,76" /></G> : <G fill={referencePalette.tone27} stroke={referencePalette.tone20} strokeWidth="1.5">{([[31,55],[53,50],[73,58],[40,74],[65,77]] as const).map(([x,y],i) => <Path key={i} d={`M${x} ${y}l16-5 11 9-16 6z m0 0v15l11 9V${y+9} m11 0l16-6v15l-16 6`} />)}</G>}
    <Path d="M30 94h27 M64 94h24" stroke={referencePalette.tone14} strokeWidth="2" />
  </Svg>;
}
export function PrismaticGlow({ size = 190 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  return <Svg pointerEvents="none" width={size} height={size} viewBox="0 0 200 200">
    <Defs>
      <RadialGradient id={`${id}g`}><Stop offset="0" stopColor={referencePalette.tone12} stopOpacity=".2" /><Stop offset="0.45" stopColor={referencePalette.tone3} stopOpacity=".38" /><Stop offset="0.7" stopColor={referencePalette.tone13} stopOpacity=".17" /><Stop offset="1" stopColor={referencePalette.tone2} stopOpacity="0" /></RadialGradient>
      <LinearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={referencePalette.tone7} /><Stop offset="0.35" stopColor={referencePalette.tone18} /><Stop offset="0.7" stopColor={referencePalette.tone23} /><Stop offset="1" stopColor={referencePalette.tone9} /></LinearGradient>
    </Defs>
    <Circle cx="100" cy="100" r="100" fill={`url(#${id}g)`} />
    <Circle cx="100" cy="100" r="57" fill={referencePalette.tone11} fillOpacity=".18" stroke={`url(#${id}r)`} strokeWidth="12" strokeOpacity=".12" />
    <Circle cx="100" cy="100" r="54" fill="none" stroke={`url(#${id}r)`} strokeWidth="5" strokeOpacity=".4" />
    <Circle cx="100" cy="100" r="51" fill="none" stroke={`url(#${id}r)`} strokeWidth="2" />
  </Svg>;
}
