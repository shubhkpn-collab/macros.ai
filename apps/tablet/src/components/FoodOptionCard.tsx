import React, {useState,useEffect} from 'react';
import {Pressable,Text,View,Image,Linking} from 'react-native';
import {color,space,type FoodOptionView} from '@macros/tablet-view-model';
import {FoodArt,GlassSheen} from './ReferenceKit.js';

/** The exact option label comes from search orchestration, shared with spoken selection. */
export function FoodOptionCard({option,onSelect}:{option:FoodOptionView;onSelect:(id:string)=>void}):React.JSX.Element {
  const [imageFailed,setImageFailed]=useState(false);
  useEffect(()=>setImageFailed(false),[option.productImage?.url]);
  const image=option.productImage;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Option ${option.optionLabel}. ${option.displayName}. ${option.brand!==null?`${option.brand}. `:''}${option.preparationState}`}
    onPress={()=>onSelect(option.productVersionId)} style={({pressed})=>({width:'30%',minWidth:168,maxWidth:244,minHeight:300,borderRadius:22,borderWidth:1,borderColor:pressed?color.textPrimary:color.borderStrong,backgroundColor:pressed?color.surfaceActive:color.surface,margin:6,padding:space.md,alignItems:'center'})}>
    <GlassSheen selected={false}/>
    <View style={{alignSelf:'flex-start',borderRadius:18,backgroundColor:color.surfaceMuted,paddingHorizontal:14,paddingVertical:8}}><Text style={{color:color.macroProtein,fontSize:20,fontWeight:'700'}}>Option {option.optionLabel}</Text></View>
    <View style={{marginTop:12,marginBottom:8}}>{image&&!imageFailed?<Image source={{uri:image.url}} style={{width:120,height:120}} resizeMode="contain" accessibilityLabel={`${option.displayName} package photo`} onError={()=>setImageFailed(true)}/>:<FoodArt name={option.displayName} size={120}/>}</View>
    <Text style={{color:color.textPrimary,fontSize:22,fontStyle:'italic',fontWeight:'600',textAlign:'center'}}>{option.displayName}</Text>
    {option.brand!==null?<Text style={{color:color.textSecondary,fontSize:16,textAlign:'center',marginTop:6}}>{option.brand}</Text>:null}
    {option.servingLabel?<Text style={{color:color.textSecondary,fontSize:13,marginTop:8}}>{option.servingLabel}</Text>:null}
    {option.catalogSource?<Text style={{color:color.textMuted,fontSize:11,marginTop:5}}>{option.catalogSource}</Text>:null}
    <View style={{borderRadius:18,borderWidth:1,borderColor:option.preparationMatters?color.warning:color.border,paddingHorizontal:12,paddingVertical:7,marginTop:12}}><Text style={{color:option.preparationMatters?color.warning:color.textSecondary,fontSize:15,textAlign:'center'}}>{option.preparationState}{option.preparationMatters?' · check preparation':''}</Text></View>
    <Text style={{color:color.textMuted,fontSize:12,marginTop:10}}>{image&&!imageFailed?'Product photo':'Illustration · photo unavailable'} · say option {option.optionLabel}</Text>
    {image&&!imageFailed?<Text accessibilityRole="link" onPress={event=>{event.stopPropagation();void Linking.openURL(image.sourceUrl);}} style={{fontSize:10,color:color.textMuted,marginTop:5,textAlign:'center'}}>{image.attribution}</Text>:null}
    {image&&!imageFailed?<Text accessibilityRole="link" onPress={event=>{event.stopPropagation();void Linking.openURL('https://creativecommons.org/licenses/by-sa/3.0/');}} style={{fontSize:10,color:color.textMuted,marginTop:3}}>{image.license}</Text>:null}
  </Pressable>;
}
