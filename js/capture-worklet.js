// Odbiór z wejścia audio: przepróbkowanie do częstotliwości dekodera (interpolacja liniowa – sygnał jest wcześniej
// odfiltrowany dolnoprzepustowo w grafie Web Audio) i wysyłanie paczek 16-bitowych próbek do wątku strony.
class ArgosCapture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const p = options.processorOptions;
        this.step = sampleRate / p.targetRate;
        this.pos = 0;
        this.prev = 0;
        this.chunk = new Int16Array(Math.round(p.targetRate * p.chunkMs / 1000));
        this.fill = 0;
        this.peak = 0;
        this.port.onmessage = e => { if (e.data === 'stop') this.stopped = true; };
    }

    push(v) {
        const a = Math.abs(v);
        if (a > this.peak) this.peak = a;
        v = Math.max(-1, Math.min(1, v));
        this.chunk[this.fill++] = v < 0 ? v * 32768 : v * 32767;
        if (this.fill === this.chunk.length) {
            const bytes = new Uint8Array(this.chunk.buffer.slice(0));
            this.port.postMessage({ pcm: bytes, peak: this.peak }, [bytes.buffer]);
            this.fill = 0;
            this.peak = 0;
        }
    }

    process(inputs) {
        if (this.stopped) return false;
        // Wejście nieaktywne (np. pętla testowa bez nadawania) – Web Audio nie podaje wtedy próbek; dekoder potrzebuje ciszy.
        const ch = (inputs[0] && inputs[0][0]) || this.silence || (this.silence = new Float32Array(128));
        // pos: położenie kolejnej próbki wyjściowej względem początku bloku; -1 = ostatnia próbka poprzedniego bloku.
        let pos = this.pos;
        for (;;) {
            const i0 = Math.floor(pos);
            if (i0 + 1 >= ch.length) break;
            const a = i0 < 0 ? this.prev : ch[i0];
            this.push(a + (ch[i0 + 1] - a) * (pos - i0));
            pos += this.step;
        }
        this.prev = ch[ch.length - 1];
        this.pos = pos - ch.length;
        return true;
    }
}

registerProcessor('argos-capture', ArgosCapture);
