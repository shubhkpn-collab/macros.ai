export type KitchenPhase = 'idle'|'connecting'|'listening'|'thinking'|'speaking'|'error';
export interface KitchenSessionPorts {
  send(event: unknown): void;
  execute(name: string, args: string, current: () => boolean): Promise<Record<string,unknown>>;
  speechStarted(itemId: string): void;
  transcript(itemId: string, text: string): void;
  status(phase: KitchenPhase, text: string): void;
  end(): void;
}
/** Protocol state owns turn ordering, interruption and duplicate protection. Audio stays on WebRTC. */
export class KitchenSession {
  private live = true;
  private audioItem = '';
  private turn = 0;
  private responses = new Map<string, number>();
  private completed = new Set<string>();
  private called = new Set<string>();
  private transcripts = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private ports: KitchenSessionPorts) {}
  close(): void { this.live = false; this.turn++; this.responses.clear(); }
  ready(): void {
    if (!this.live) return;
    this.ports.status('listening', 'Kitchen voice is live. Speak naturally; you can interrupt me.');
    this.ports.send({type:'response.create'});
  }
  async handle(event: unknown): Promise<void> {
    if (!this.live || event === null || typeof event !== 'object' || Array.isArray(event)) return;
    const data = event as Record<string,unknown>;
    if (data.type === 'input_audio_buffer.speech_started' && typeof data.item_id === 'string') {
      this.turn++;
      this.audioItem = data.item_id;
      this.ports.speechStarted(data.item_id);
      this.ports.status('listening', 'Listening…');
      return;
    }
    if (data.type === 'input_audio_buffer.speech_stopped') {this.ports.status('thinking','Thinking…');return;}
    if (data.type === 'conversation.item.input_audio_transcription.completed'
      && typeof data.item_id === 'string' && typeof data.transcript === 'string') {
      if (data.item_id !== this.audioItem || this.transcripts.has(data.item_id)) return;
      this.transcripts.add(data.item_id);
      if (this.transcripts.size > 200) {this.ports.end();return;}
      this.ports.transcript(data.item_id, data.transcript);
      if (/^(?:end (?:the )?conversation|stop listening|goodbye macros|that'?s all(?: thanks)?)[.!?]*$/i.test(data.transcript.trim())) this.ports.end();
      return;
    }
    if (data.type === 'response.created') {
      const response = data.response as {id?: unknown} | undefined;
      if (typeof response?.id === 'string') {
        this.responses.set(response.id,this.turn);
        if (this.responses.size > 200) {this.ports.end();return;}
      }
      this.ports.status('thinking','Thinking…'); return;
    }
    if (data.type === 'output_audio_buffer.started') {this.ports.status('speaking','Speaking… you can interrupt me');return;}
    if (data.type === 'output_audio_buffer.stopped' || data.type === 'output_audio_buffer.cleared') {
      this.ports.status('listening','Listening • ask a follow-up anytime'); return;
    }
    if (data.type === 'response.output_audio_transcript.done' && typeof data.transcript === 'string') {
      this.ports.status('speaking',data.transcript.slice(0,1000));return;
    }
    if (data.type === 'error') {
      const error = data.error as {code?: unknown} | undefined;
      // A racing response is recoverable; do not end a valid media call for it.
      if (error?.code === 'conversation_already_has_active_response') return;
      this.ports.status('error','Voice connection interrupted. End and try again.');
      this.ports.end(); return;
    }
    if (data.type !== 'response.done') return;
    const response = data.response as {id?:unknown;status?:unknown;output?:unknown} | undefined;
    if (typeof response?.id !== 'string' || this.completed.has(response.id)) return;
    this.completed.add(response.id);
    if (this.completed.size > 200) {this.ports.end();return;}
    const turn = this.responses.get(response.id);
    this.responses.delete(response.id);
    // Arguments-done also fires for cancelled responses. Only completed responses may invoke tools.
    if (response.status !== 'completed' || turn === undefined || turn !== this.turn || !Array.isArray(response.output)) return;
    const tools = response.output.filter(item => item !== null && typeof item === 'object' && item.type === 'function_call');
    if (!tools.length) return;
    if (tools.length > 8) {this.ports.end();return;}
    const current = () => this.live && turn === this.turn;
    const run = async () => {
      let executed = false;
      for (const item of tools) {
        if (!current()) return;
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string'
          || item.arguments.length > 2048 || this.called.has(item.call_id)) continue;
        this.called.add(item.call_id);
        if (this.called.size > 200) {this.ports.end();return;}
        let output: Record<string, unknown>;
        try {output = await this.ports.execute(item.name,item.arguments,current);}
        catch {output = {error:'Kitchen action unavailable. Please try again.'};}
        if (!current()) return;
        this.ports.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:item.call_id,output:JSON.stringify(output)}});
        executed = true;
      }
      if (executed && current()) this.ports.send({type:'response.create'});
    };
    this.tail = this.tail.then(run,run);
    await this.tail;
  }
}
