import { AppState, NativeModules, PermissionsAndroid } from 'react-native';
import { mediaDevices, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { KitchenSession, type KitchenPhase } from '@macros/tablet-voice';
import type { KitchenActions } from './kitchen-actions.js';

interface KitchenAudioNative {
  getKitchenToken(): Promise<string | null>;
  beginKitchenAudio(): Promise<void>;
  endKitchenAudio(): void;
}
/** One continuous audio session; no Android SpeechRecognizer or TTS in this path. */
export class KitchenConversation {
  private peer: RTCPeerConnection | null = null;
  private stream: Awaited<ReturnType<typeof mediaDevices.getUserMedia>> | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private connectingTimeout: ReturnType<typeof setTimeout> | null = null;
  private channel: ReturnType<RTCPeerConnection['createDataChannel']> | null = null;
  private session: KitchenSession | null = null;
  private permissionPrompt = false;
  constructor(private actions: KitchenActions, private status: (text: string, active: boolean, phase: KitchenPhase) => void) {}
  private native(): KitchenAudioNative | undefined {return NativeModules.MacrosSpeech as KitchenAudioNative | undefined;}
  background(): void {if (!this.permissionPrompt) this.stop();}
  stop(): void {
    this.generation++;
    this.session?.close(); this.session = null;
    this.actions.reset();
    this.abort?.abort(); this.abort = null;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.connectingTimeout) clearTimeout(this.connectingTimeout);
    this.timeout = null; this.connectingTimeout = null;
    const channel = this.channel; this.channel = null; channel?.close();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.peer?.close(); this.peer = null;
    try { this.native()?.endKitchenAudio?.(); } catch { /* Missing older bridge must not prevent microphone shutdown. */ }
    this.status('Microphone off. Tap to start a kitchen conversation.', false, 'idle');
  }
  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const live = () => generation === this.generation;
    const fail = (message: string) => {
      if (!live()) return;
      this.stop(); this.status(message,false,'error');
    };
    let stage = 'USB setup';
    this.status('Starting kitchen voice…', true,'connecting');
    this.connectingTimeout = setTimeout(() => fail(`Voice could not connect at ${stage}. Tap to retry.`),40_000);
    try {
      const native = this.native();
      if (!native || typeof native.beginKitchenAudio !== 'function' || typeof native.getKitchenToken !== 'function') {fail('This build is missing the voice audio bridge. Please install the current preview.');return;}
      const token = await native.getKitchenToken();
      if (!live()) return;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        fail('Connect this phone to the Mac voice backend over USB, then start again.');return;
      }
      stage = 'microphone permission';
      let permitted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (!live()) return;
      if (!permitted) {
        this.permissionPrompt = true;
        try {permitted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) === PermissionsAndroid.RESULTS.GRANTED;}
        finally {this.permissionPrompt = false;}
      }
      if (!live()) return;
      if (!permitted) {fail('Allow microphone access to start kitchen voice.');return;}
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {fail('Return to MACROS, then tap Talk to Macros.');return;}
      stage = 'audio capture';
      await native.beginKitchenAudio();
      if (!live()) {native.endKitchenAudio();return;}
      const stream = await mediaDevices.getUserMedia({audio:true,video:false});
      if (!live()) {stream.getTracks().forEach(track => track.stop());return;}
      this.stream = stream;
      const peer = new RTCPeerConnection(); this.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track,stream));
      const channel = peer.createDataChannel('oai-events'); this.channel = channel;
      const session = new KitchenSession({
        send: event => {if (live() && channel.readyState === 'open') channel.send(JSON.stringify(event));},
        execute: (name,args,current) => this.actions.execute(name,args,() => live() && current()),
        speechStarted: id => this.actions.speechStarted(id),
        transcript: (id,text) => this.actions.transcript(id,text),
        status: (phase,text) => {if (live()) this.status(text,true,phase);},
        end: () => {if (live()) this.stop();},
      });
      this.session = session;
      channel.onopen = () => {
        if (!live()) return;
        if (this.connectingTimeout) clearTimeout(this.connectingTimeout);
        this.connectingTimeout = null;
        this.timeout = setTimeout(() => this.stop(),20 * 60_000);
        session.ready();
      };
      channel.onclose = () => {if (live()) fail('Voice connection closed. Tap to reconnect.');};
      channel.onerror = () => fail('Voice data connection failed. Tap to retry.');
      channel.onmessage = (event: unknown) => {
        if (!live()) return;
        try {void session.handle(JSON.parse(String((event as {data:unknown}).data))).catch(() => fail('Voice action failed. Tap to reconnect.'));}
        catch { /* Ignore malformed remote events; they cannot invoke tools. */ }
      };
      stage = 'audio offer';
      const offer = await peer.createOffer({});
      if (!live()) return;
      await peer.setLocalDescription(offer);
      if (!live()) return;
      this.status('Connecting to your kitchen assistant…',true,'connecting');
      stage = 'backend handshake';
      const abort = new AbortController(); this.abort = abort;
      const response = await fetch('http://127.0.0.1:8791/voice/conversation', {
        method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify({sdp:offer.sdp}),signal:abort.signal,
      });
      if (!live()) return;
      if (!response.ok) {
        const messages: Record<number,string> = {
          401:'USB voice connection expired. Reconnect the phone from the Mac.',
          429:'Please wait 30 seconds before starting another conversation.',
          503:'Configure the OpenAI key on the Mac backend, then restart it.',
          502:'OpenAI could not start voice. Check project billing and Realtime access.',
        };
        fail(messages[response.status] ?? 'Kitchen backend could not connect. Tap to retry.');return;
      }
      const answer = await response.json() as {sdp?:unknown};
      if (!live()) return;
      if (typeof answer.sdp !== 'string') {fail('Invalid voice connection response.');return;}
      stage = 'audio negotiation';
      await peer.setRemoteDescription(new RTCSessionDescription({type:'answer',sdp:answer.sdp}));
    } catch {
      fail(`Kitchen voice failed at ${stage}. Check the Mac connection and retry.`);
    }
  }
}
