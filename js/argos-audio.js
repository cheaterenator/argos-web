// Dźwięk, wyświetlacz i drobne usługi przeglądarki dla aplikacji Argos (wywoływane z .NET przez JS interop).

let ctx = null;          // AudioContext – tworzony po dotknięciu ekranu (wymóg przeglądarek, zwłaszcza Safari)
let master = null;       // głośność nadawania
let speakerEq = null;    // korekcja dla głośnika telefonu (wejście łańcucha głośnika)
let outTarget = null;    // dokąd idzie szyna nadawania: wyjście, korekcja głośnika albo nigdzie (pętla testowa)
let nextFree = 0;        // koniec ostatniej zaplanowanej transmisji (czas AudioContext)
const sources = new Set();
let capture = null;      // { stream, source, lp1, nodes[], worklet, audio, dotnet, paused }
let resumeTimer = null;
let workletLoaded = false;
let buzzer = null;
let wakeLock = null;
let wantWakeLock = false;
let loopback = false;    // pętla testowa: nadawanie wraca na wejście, bez głośnika i mikrofonu
let speaker = false;     // głośnik telefonu: korekcja tonów i wstrzymywanie mikrofonu na czas nadawania

function setSessionType(type) {
    // Safari 16.4+: „playback” nie jest wyciszane przełącznikiem trybu cichego, „play-and-record” przy mikrofonie.
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { }
}

function connectOutput() {
    const target = loopback ? null : speaker ? speakerEq : ctx.destination;
    if (target === outTarget) return;
    if (outTarget) { try { master.disconnect(outTarget); } catch { } }
    if (target) master.connect(target);
    outTarget = target;
}

export async function init() {
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        master = ctx.createGain();
        // Głośnik telefonu słabo oddaje niskie tony DTMF (697 Hz o ok. 12 dB ciszej niż 1209–1633 Hz), a dekoder
        // dopuszcza 10 dB różnicy grup. Filtr szczytowy podnosi 697/770 Hz o 6–8 dB względem grupy wysokiej,
        // 941 Hz o 3–5 dB; całość ściszona tak, żeby suma tonów się nie obcinała (szczyt < 1).
        speakerEq = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 700, Q: 1.2, gain: 10 });
        const headroom = ctx.createGain();
        headroom.gain.value = 0.57;
        speakerEq.connect(headroom).connect(ctx.destination);
        connectOutput();
        setSessionType('playback');
    }
    if (ctx.state !== 'running') await ctx.resume();
    return {
        sampleRate: ctx.sampleRate,
        sinkSupported: typeof ctx.setSinkId === 'function',
        wakeLockSupported: 'wakeLock' in navigator,
        vibrateSupported: typeof navigator.vibrate === 'function',
        userAgent: navigator.userAgent,
    };
}

export async function resume() {
    if (ctx && ctx.state !== 'running') await ctx.resume();
    return ctx ? ctx.state : 'none';
}

export async function devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    const map = kind => list.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map(d => ({ id: d.deviceId, label: d.label || '' }));
    return { inputs: map('audioinput'), outputs: map('audiooutput') };
}

export async function setOutput(id) {
    if (ctx && typeof ctx.setSinkId === 'function') await ctx.setSinkId(id || '');
}

// Pętla testowa: szyna nadawania nie idzie na wyjście audio, tylko (przez te same filtry) na wejście dekodera.
export function setLoopback(on) {
    if (!ctx) return;
    loopback = on;
    connectOutput();
}

// Głośnik telefonu (test bez przejściówki): korekcja tonów, a mikrofon jest wyłączany na czas nadawania – przy
// włączonym mikrofonie iPhone kieruje dźwięk strony do słuchawki rozmów. Jak w radiu: nadając, nie odbiera.
export function setSpeaker(on) {
    if (!ctx) return;
    speaker = on;
    connectOutput();
    if (!on && capture && capture.paused) resumeInput();
}

export function setLevel(value) {
    if (master) master.gain.value = value;
}

// Transmisja: 16-bitowe próbki (little endian), start za delayMs (ujemne – od razu); kolejne transmisje nie nachodzą
// na siebie. Zwraca [opóźnienie startu w s, czas trwania w s].
export function play(bytes, rate, delayMs) {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const buffer = ctx.createBuffer(1, pcm.length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    let start = ctx.currentTime + Math.max(0.03, delayMs / 1000);
    start = Math.max(start, nextFree);
    const halfDuplex = speaker && !loopback && capture && (capture.stream || capture.paused);
    if (halfDuplex && !capture.paused) {
        pauseInput();
        start = Math.max(start, ctx.currentTime + 0.4); // chwila na przełączenie toru na głośnik
    }
    nextFree = start + buffer.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
    src.start(start);
    if (halfDuplex) {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(resumeInput, (nextFree - ctx.currentTime) * 1000 + 300);
    }
    return [start - ctx.currentTime, buffer.duration];
}

export function stopAll() {
    for (const s of sources) { try { s.stop(); } catch { } }
    sources.clear();
    nextFree = 0;
    if (capture && capture.paused) {
        clearTimeout(resumeTimer);
        resumeInput();
    }
}

export async function startInput(dotnet, deviceId, targetRate) {
    stopInput();
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream = null;
    if (!loopback) {
        setSessionType('play-and-record');
        stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    if (!workletLoaded) {
        await ctx.audioWorklet.addModule('js/capture-worklet.js');
        workletLoaded = true;
    }
    const source = stream ? ctx.createMediaStreamSource(stream) : master;
    // Filtr antyaliasingowy przed przepróbkowaniem (2 × Butterworth 2. rzędu).
    const lp1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: targetRate * 0.42, Q: 0.707 });
    const lp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: targetRate * 0.42, Q: 0.707 });
    const worklet = new AudioWorkletNode(ctx, 'argos-capture', { processorOptions: { targetRate, chunkMs: 40 } });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    worklet.port.onmessage = e => dotnet.invokeMethodAsync('OnAudio', e.data.pcm, e.data.peak);
    source.connect(lp1).connect(lp2).connect(worklet).connect(mute).connect(ctx.destination);
    capture = { stream, source, lp1, nodes: [lp1, lp2, worklet, mute], worklet, audio, dotnet, paused: false };
    if (!stream) return 'pętla testowa (nadawanie tej strony)';
    const track = stream.getAudioTracks()[0];
    return track ? track.label : '';
}

// Mikrofon wyłączony na czas nadawania przez głośnik; dekoder dostaje w tym czasie ciszę.
function pauseInput() {
    if (!capture || !capture.stream) return;
    try { capture.source.disconnect(); } catch { }
    for (const t of capture.stream.getTracks()) t.stop();
    capture.stream = null;
    capture.source = null;
    capture.paused = true;
    setSessionType('playback');
}

async function resumeInput() {
    const c = capture;
    if (!c || !c.paused) return;
    try {
        setSessionType('play-and-record');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: c.audio });
        if (capture !== c || !c.paused) { for (const t of stream.getTracks()) t.stop(); return; }
        c.stream = stream;
        c.source = ctx.createMediaStreamSource(stream);
        c.source.connect(c.lp1);
        c.paused = false;
    } catch (e) {
        c.dotnet.invokeMethodAsync('OnInputError', 'nie udało się wznowić mikrofonu po nadawaniu: ' + (e && e.message ? e.message : e));
    }
}

export function stopInput() {
    clearTimeout(resumeTimer);
    if (!capture) return;
    capture.worklet.port.postMessage('stop');
    capture.worklet.port.onmessage = null;
    for (const n of capture.nodes) { try { n.disconnect(); } catch { } }
    if (capture.source && capture.source !== master) { try { capture.source.disconnect(); } catch { } }
    if (capture.source === master) { try { master.disconnect(capture.lp1); } catch { } }
    if (capture.stream) for (const t of capture.stream.getTracks()) t.stop();
    capture = null;
    setSessionType('playback');
}

// Brzęczyk alarmu (2 kHz, 350 ms / 150 ms) – idzie tym samym wyjściem co nadawanie.
export function setBuzzer(on) {
    if (!ctx) return;
    if (on && !buzzer) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 2000;
        gain.gain.value = 0;
        const t0 = ctx.currentTime + 0.02;
        for (let i = 0; i < 600; i++) {   // ok. 5 minut – potem włączany ponownie przez .NET
            gain.gain.setValueAtTime(0.15, t0 + i * 0.5);
            gain.gain.setValueAtTime(0, t0 + i * 0.5 + 0.35);
        }
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(t0 + 300);
        osc.onended = () => { if (buzzer && buzzer.osc === osc) buzzer = null; };
        buzzer = { osc, gain };
    } else if (!on && buzzer) {
        try { buzzer.osc.stop(); } catch { }
        buzzer.gain.disconnect();
        buzzer = null;
    }
}

export function vibrate(pattern) {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
}

// Ekran nie gaśnie, dopóki strona jest widoczna (po powrocie do strony blokada jest odnawiana).
export async function keepAwake(on) {
    wantWakeLock = on;
    if (!('wakeLock' in navigator)) return false;
    if (on && !wakeLock) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch { return false; }
    } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }
    return true;
}

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        if (ctx && ctx.state !== 'running') { try { await ctx.resume(); } catch { } }
        if (wantWakeLock && !wakeLock) await keepAwake(true);
    }
});

export function download(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ───────────── wyświetlacz LCD (matryca znaków 5×8 jak HD44780) ─────────────

const glyphs = [
    [0x1f, 0x0a, 0x00, 0x15, 0x1f, 0x1f, 0x04, 0x04], // 0: RS232
    [0x1f, 0x15, 0x15, 0x0e, 0x04, 0x04, 0x04, 0x04], // 1: antena
    [0x01, 0x1f, 0x11, 0x11, 0x1f, 0x1f, 0x1f, 0x1f], // 2: telefon
    [0x0e, 0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], // 3: akumulator (lewa część)
    [0x0e, 0x1f, 0x01, 0x05, 0x0f, 0x05, 0x01, 0x1f], // 4: akumulator (prawa część)
    [0x02, 0x04, 0x08, 0x04, 0x02, 0x14, 0x18, 0x1c], // 5: zasilanie
    [0x04, 0x0e, 0x0e, 0x0e, 0x1f, 0x00, 0x04, 0x04], // 6: alarm
];

const palettes = {
    green: ['rgb(150,208,72)', 'rgb(138,196,64)', 'rgb(18,42,10)'],
    red: ['rgb(232,82,70)', 'rgb(218,70,60)', 'rgb(45,6,4)'],
    yellow: ['rgb(236,214,64)', 'rgb(222,200,54)', 'rgb(45,38,4)'],
};

const lcdObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => { for (const e of entries) if (e.target._lcd) drawLcd(e.target, ...e.target._lcd); })
    : null;

export function drawLcd(canvas, lines, columns, backlight) {
    if (!canvas) return;
    if (!canvas._lcd && lcdObserver) lcdObserver.observe(canvas);
    canvas._lcd = [lines, columns, backlight];
    const rows = lines.length;
    const wDots = 8 + columns * 5 + (columns - 1), hDots = 8 + rows * 8 + (rows - 1) * 2;
    const cssWidth = canvas.clientWidth || 300;
    const ratio = window.devicePixelRatio || 1;
    const dot = Math.max(1, Math.floor(cssWidth * ratio / wDots));
    canvas.width = wDots * dot;
    canvas.height = hDots * dot;
    canvas.style.height = (hDots * dot / ratio) + 'px';
    const g = canvas.getContext('2d');
    const [bg, cell, ink] = palettes[backlight] || palettes.green;
    g.fillStyle = bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = `bold ${Math.round(8 * dot * 0.9)}px ui-monospace, Menlo, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const pixel = Math.max(1, dot - (dot >= 3 ? 1 : 0));
    for (let y = 0; y < rows; y++) {
        const text = (lines[y] || '').padEnd(columns).substring(0, columns);
        for (let x = 0; x < columns; x++) {
            const cx = (4 + x * 6) * dot, cy = (4 + y * 10) * dot;
            g.fillStyle = cell;
            g.fillRect(cx, cy, 5 * dot, 8 * dot);
            const c = text.charCodeAt(x);
            g.fillStyle = ink;
            if (c < glyphs.length) {
                for (let r = 0; r < 8; r++)
                    for (let col = 0; col < 5; col++)
                        if (glyphs[c][r] & (0x10 >> col)) g.fillRect(cx + col * dot, cy + r * dot, pixel, pixel);
            } else if (c !== 32) {
                g.fillText(text[x], cx + 2.5 * dot, cy + 7 * dot);
            }
        }
    }
}
