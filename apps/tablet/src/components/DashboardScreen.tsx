import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { referencePalette, color, type TabletViewModel } from '@macros/tablet-view-model';
import { Icon, Ring, FoodArt } from './ReferenceKit.js';
import type { ScreenActions } from './screens.js';

const section = { backgroundColor: color.surface, borderRadius: 24, padding: 24, marginBottom: 16, borderWidth: 1, borderColor: referencePalette.tone4 } as const;
export function DashboardScreen({ vm, actions, onGenerate, onEditGoals }: { vm: TabletViewModel; actions: ScreenActions; onGenerate: () => void; onEditGoals: () => void }) {
  const daily = vm.daily;
  const protein = vm.macros.find(m => m.label === 'Protein');
  const fat = vm.macros.find(m => m.label === 'Fat');
  const carbs = vm.macros.find(m => m.label === 'Carbs');
  return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingTop: 12, maxWidth: 760, width: '100%', alignSelf: 'center' }}>
    <Text style={{ color: color.textMuted, fontSize: 14, marginBottom: 18 }}>{daily?.date ?? 'Today'} · YOUR DAILY OVERVIEW</Text>
    <View style={section}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <Text style={{ color: color.textPrimary, fontSize: 24, fontWeight: '600' }}>Daily totals</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Generate a food recommendation" onPress={onGenerate} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 14, borderRadius: 28, backgroundColor: color.surfaceMuted }}><Icon name="leaf" size={18} /><Text style={{ color: color.textPrimary, fontSize: 16 }}>Generate</Text><Icon name="arrow" size={16} /></Pressable>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
        <Ring label="Calories" value={daily?.displayCalories ?? '—'} goal={daily?.displayCalorieGoal} fraction={daily?.calorieFraction ?? null} size={132} />
        <Ring label="Protein" value={protein?.displayConsumed ?? '—'} goal={protein?.displayGoal} fraction={protein?.fraction ?? null} size={132} />
        <Ring label="Fat" value={fat?.displayConsumed ?? '—'} goal={fat?.displayGoal} fraction={fat?.fraction ?? null} size={132} />
      </View>
    </View>
    <View style={{ ...section, flexDirection: 'row', paddingVertical: 20 }}>
      {[['Carbs', carbs?.displayConsumed === undefined ? '—' : `${carbs.displayConsumed} g`], ['Remaining', daily === null ? '—' : `${daily.displayRemainingCalories} kcal`], ['Foods logged', daily?.displayItems ?? '0']].map(([label,value]) => <View key={label} style={{ flex: 1, alignItems: 'center' }}><Text style={{ color: color.textMuted, fontSize: 14 }}>{label}</Text><Text style={{ color: color.textPrimary, fontWeight: '600', fontSize: 22, marginTop: 10 }}>{value}</Text></View>)}
    </View>
    <View style={section}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ color: color.textPrimary, fontSize: 23, fontWeight: '600' }}>Today's food</Text><Pressable accessibilityRole="button" accessibilityLabel="Add food from dashboard" onPress={actions.onAddFood} style={{ padding: 14 }}><Icon name="plus" /></Pressable></View>
      {vm.recent.length === 0 ? <View style={{ alignItems: 'center', padding: 26 }}><Icon name="leaf" size={32} tint={color.macroCarbs} /><Text style={{ color: color.textSecondary, fontSize: 17, marginTop: 12 }}>Your day starts with the first bite.</Text><Pressable onPress={actions.onAddFood} accessibilityRole="button" accessibilityLabel="Log your first food" style={{ padding: 16 }}><Text style={{ color: color.macroProtein, fontSize: 16 }}>Log a food</Text></Pressable></View> : vm.recent.map((food,index) => <View key={`${food.displayName}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: color.border, paddingVertical: 10 }}><FoodArt name={food.displayName} size={48} /><View style={{ flex: 1, marginLeft: 12 }}><Text style={{ color: color.textPrimary, fontSize: 18 }}>{food.displayName}</Text><Text style={{ color: color.textMuted, fontSize: 13, marginTop: 5 }}>{food.displayKcal} kcal</Text></View><Text style={{ color: color.textPrimary, fontSize: 20, fontWeight: '600' }}>{food.displayWeight ?? ''}</Text></View>)}
      {protein !== undefined ? <View style={{ marginTop: 20 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: color.textSecondary, fontSize: 16 }}>Protein focus</Text><Text style={{ color: color.textPrimary }}>{protein.displayConsumed} / {protein.displayGoal} g</Text></View><View style={{ height: 6, backgroundColor: color.surfaceMuted, borderRadius: 4, marginTop: 12 }}><View style={{ height: 6, borderRadius: 4, width: `${(protein.fraction ?? 0) * 100}%`, backgroundColor: color.macroCarbs }} /></View></View> : null}
    </View>
    <View style={section}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}><Text style={{ color: color.textPrimary, fontSize: 23, fontWeight: '600' }}>Macros goals</Text><Pressable accessibilityRole="button" accessibilityLabel="Edit daily goal" onPress={onEditGoals} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14 }}><Icon name="edit" size={18} /><Text style={{ color: color.textSecondary }}>Edit</Text></Pressable></View>
      <View style={{ flexDirection: 'row' }}>{vm.macros.map(m => <Ring key={m.label} label={m.label} value={m.displayGoal} fraction={m.fraction} size={88} />)}<Ring label="Calories" value={daily?.displayCalorieGoal ?? '—'} fraction={daily?.calorieFraction ?? null} size={88} /></View>
    </View>
    {vm.energy !== null ? <View style={{ padding: 20 }}><Text style={{ color: color.textSecondary, fontSize: 17 }}>{vm.energy.semantic}</Text><Text style={{ color: color.textMuted, fontSize: 13, marginTop: 7 }}>{vm.energy.incomplete ? 'Energy estimate has incomplete inputs.' : 'Energy balance is estimated from your current inputs.'}</Text></View> : null}
    {daily?.goalBelowFloor === true ? <Text style={{ color: color.warning, fontSize: 16, padding: 20 }}>Your target is below the configured calorie floor. Review your goal before using it.</Text> : null}
  </ScrollView>;
}

export function GoalSheet({ vm, open, onClose, onSave }: { vm: TabletViewModel; open: boolean; onClose: () => void; onSave: (delta: number) => Promise<boolean> }) {
  const [value,setValue] = useState(String(vm.daily?.targetDeltaKcal ?? 0));
  const [saving,setSaving] = useState(false); const [error,setError] = useState('');
  const save = async () => {
    if (saving) return;
    const delta = Number(value);
    if (value.trim() === '' || !Number.isFinite(delta)) { setError('Enter a valid calorie adjustment.'); return; }
    setSaving(true); setError('');
    try { if (await onSave(delta)) onClose(); else setError('Your goal could not be saved. Please try again.'); }
    catch { setError('Your goal could not be saved. Please try again.'); }
    finally { setSaving(false); }
  };
  return <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: referencePalette.tone1, alignItems: 'center', justifyContent: 'center', padding: 24 }}><View style={{ ...section, width: '100%', maxWidth: 560, padding: 32 }}>
      <Text style={{ color: color.textPrimary, fontSize: 28, fontWeight: '600' }}>Your daily goal</Text>
      <Text style={{ color: color.textSecondary, fontSize: 17, lineHeight: 26, marginVertical: 20 }}>Set an adjustment to your estimated daily expenditure. Zero maintains the estimate. Macro targets update through the existing calculation policy.</Text>
      <Text style={{ color: color.textMuted, marginBottom: 10 }}>Calorie adjustment (kcal)</Text>
      <TextInput accessibilityLabel="Daily calorie adjustment" value={value} onChangeText={setValue} keyboardType="numbers-and-punctuation" style={{ backgroundColor: color.surfaceMuted, color: color.textPrimary, fontSize: 24, borderRadius: 14, padding: 18 }} />
      {error !== '' ? <Text accessibilityLiveRegion="polite" style={{ color: color.danger, marginTop: 16 }}>{error}</Text> : null}
      <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Save daily goal" onPress={() => { void save(); }} style={{ backgroundColor: color.accent, opacity: saving ? .5 : 1, borderRadius: 18, padding: 20, alignItems: 'center', marginTop: 24 }}><Text style={{ color: color.canvas, fontSize: 18, fontWeight: '600' }}>{saving ? 'Saving…' : 'Save goal'}</Text></Pressable>
      <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Cancel goal editing" onPress={onClose} style={{ padding: 18, alignItems: 'center' }}><Text style={{ color: color.textSecondary, fontSize: 17 }}>Cancel</Text></Pressable>
    </View></View>
  </Modal>;
}
