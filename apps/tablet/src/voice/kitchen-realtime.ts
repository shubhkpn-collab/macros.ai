import { NativeModules, PermissionsAndroid } from 'react-native';
import { mediaDevices, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import type { TabletViewModel } from '@macros/tablet-view-model';

/** Session owned by the visible app. Stops microphone on close/background. */
export class KitchenConversation {
  private peer: RTCPeerConnection | null = null;
  private stream: Awaited<ReturnType<typeof mediaDevices.getUserMedia>> | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private channel: ReturnType<RTCPeerConnection['createDataChannel']> | null = null;
  constructor(private state: () => TabletViewModel, private status: (text: string, active: boolean) => void) {}
  stop(): void {
    this.generation++;
    this.abort?.abort(); this.abort = null;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.channel?.close(); this.channel = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.peer?.close(); this.peer = null;
    this.status('Conversation ended. Microphone off.', false);
  }
  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const live = () => generation === this.generation;
    let stage = 'USB setup';
    this.status('Starting kitchen voice…', true);
    console.info('[macros-kitchen] start');
    try {
      const token: unknown = await NativeModules.MacrosSpeech?.getKitchenToken();
      if (!live()) return;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        this.status('Kitchen voice needs the USB backend setup. Voice commands still work.', false); return;
      }
      stage = 'microphone permission';
      const permission = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) ? PermissionsAndroid.RESULTS.GRANTED : await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (!live()) return;
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        this.status('Allow microphone access to start a conversation.', false); return;
      }
      this.status('Connecting kitchen voice…', true);
      stage = 'audio capture';
      console.info('[macros-kitchen] audio capture');
      const stream = await mediaDevices.getUserMedia({audio: true, video: false});
      if (!live()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const peer = new RTCPeerConnection(); this.peer = peer;
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      const channel = peer.createDataChannel('oai-events'); this.channel = channel;
      const calls = new Set<string>();
      const send = (value: unknown) => { if (live() && channel.readyState === 'open') channel.send(JSON.stringify(value)); };
      channel.onopen = () => {
        if (!live()) return;
        this.status('Kitchen conversation live • microphone on • AI voice', true);
        send({type:'response.create'});
      };
      channel.onclose = () => { if (live()) this.stop(); };
      channel.onmessage = (event: unknown) => {
        if (!live()) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(String((event as unknown as {data: unknown}).data)); } catch { return; }
        if (data.type === 'error') { this.stop(); this.status('Voice connection interrupted. Try again.', false); return; }
        if (data.type === 'response.function_call_arguments.done' && typeof data.call_id === 'string') {
          if (calls.has(data.call_id)) return;
          calls.add(data.call_id);
          if (calls.size > 100) { this.stop(); return; }
          const vm = this.state();
          let args: unknown;
          try { args = JSON.parse(String(data.arguments)); } catch { args = null; }
          const allowed = data.name === 'get_kitchen_state' && args !== null && typeof args === 'object'
            && !Array.isArray(args) && Object.keys(args).length === 0;
          const output = allowed ? {
            preview: 'Synthetic development data; no live wearable or real scale connected.',
            screen: vm.screen, energy: vm.energy, daily: vm.daily, macros: vm.macros,
            scale: vm.scale, selectedFood: vm.selectedFood, review: vm.review,
            guidance: vm.guidance,
          } : {error:'Only read-only kitchen state is available'};
          send({type:'conversation.item.create', item:{type:'function_call_output', call_id:data.call_id, output:JSON.stringify(output)}});
          send({type:'response.create'});
        }
        if (data.type === 'response.output_audio_transcript.done' && typeof data.transcript === 'string') {
          this.status(data.transcript.slice(0,1000), true);
        }
        if (data.type === 'input_audio_buffer.speech_started') this.status('Listening… kitchen conversation live', true);
      };
      stage = 'audio connection';
      const offer = await peer.createOffer({});
      if (!live()) return;
      await peer.setLocalDescription(offer);
      const abort = new AbortController(); this.abort = abort;
      const handshakeTimer = setTimeout(() => abort.abort(), 25_000);
      stage = 'backend handshake';
      console.info('[macros-kitchen] backend handshake');
      let response: Response;
      try {
        response = await fetch('http://127.0.0.1:8791/voice/conversation', {
          method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${token}`},
          body:JSON.stringify({sdp:offer.sdp}), signal:abort.signal,
        });
      } finally { clearTimeout(handshakeTimer); }
      if (!live()) return;
      console.info('[macros-kitchen] handshake HTTP', response.status);
      if (!response.ok) { stage = `backend handshake (HTTP ${response.status})`; throw new Error('unavailable'); }
      const answer = await response.json() as {sdp?:unknown};
      if (!live()) return;
      if (typeof answer.sdp !== 'string') throw new Error('invalid answer');
      await peer.setRemoteDescription(new RTCSessionDescription({type:'answer', sdp:answer.sdp}));
      if (!live()) return;
      this.timeout = setTimeout(() => this.stop(), 5 * 60_000);
    } catch {
      if (!live()) return;
      this.stop();
      console.info('[macros-kitchen] failed stage', stage);
      this.status(`Kitchen voice failed at ${stage}. Check the Mac connection and try again.`, false);
    }
  }
}
