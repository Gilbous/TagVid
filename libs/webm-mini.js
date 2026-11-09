"use strict";
/* Mini-multiplexeur WebM (vidéo seule : VP8 ou VP9) — spécifique TagVid, sans dépendance.
   Produit un conteneur WebM valide : en-tête EBML, Segment (taille inconnue), Info, Tracks,
   Clusters de SimpleBlocks. Durée backpatchée à la finalisation. */
const WebMMini = (() => {

  function idBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function strBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }
  function vintLen(v) {
    let n = 1;
    while (v > 2 ** (7 * n) - 2) n++;
    return n;
  }
  function vint(v, len) {
    const n = len || vintLen(v);
    const b = new Uint8Array(n);
    if (n === 1) { b[0] = 0x80 | v; return b; }
    b[0] = (1 << (8 - n)) | ((v / 2 ** (8 * (n - 1))) & (2 ** (8 - n) - 1));
    for (let i = 1; i < n; i++) b[i] = (v / 2 ** (8 * (n - 1 - i))) & 0xFF;
    return b;
  }
  function el(idHex, payload) {
    if (payload instanceof Uint8Array) payload = [payload];
    let len = 0;
    for (const p of payload) len += p.length;
    return [idBytes(idHex), vint(len), ...payload];
  }

  class Muxer {
    constructor({ width, height, codec }) {
      this.parts = [];
      this.cur = null; this.curLen = 0;
      this.clusterTs = 0;
      this.lastTs = -1;
      this.durationSec = 0;
      this._push(...el("1A45DFA3", [
        ...el("4286", vint(1, 1)),
        ...el("42F7", vint(1, 1)),
        ...el("42F2", vint(4, 1)),
        ...el("42F3", vint(8, 1)),
        ...el("4282", strBytes("webm")),
        ...el("4287", vint(2, 1)),
        ...el("4285", vint(2, 1)),
      ]));
      this._push(idBytes("18538067"), new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
      this.durPart = new Uint8Array(8);
      this._push(...el("1549A966", [
        ...el("2AD7B1", vint(1000000)),
        ...el("4489", this.durPart),
        ...el("4D80", strBytes("TagVid")),
        ...el("5741", strBytes("TagVid")),
      ]));
      this._push(...el("1654AE6B", [
        ...el("AE", [
          ...el("D7", vint(1, 1)),
          ...el("73C5", vint(1, 1)),
          ...el("83", vint(1, 1)),
          ...el("86", strBytes(codec)),
          ...el("E0", [
            ...el("B0", vint(width)),
            ...el("BA", vint(height)),
          ]),
        ]),
      ]));
    }
    _push(...arrs) { for (const a of arrs) this.parts.push(a); }
    addFrame(data, keyFrame, tsMs) {
      tsMs = Math.round(tsMs);
      if (tsMs <= this.lastTs) return;
      let rel = this.cur ? tsMs - this.clusterTs : -1;
      if (!this.cur || rel > 8000 || (keyFrame && rel > 5000)) {
        this._closeCluster();
        this.clusterTs = tsMs;
        this.cur = []; this.curLen = 0;
        const tc = vint(tsMs);
        this.cur.push(idBytes("E7"), tc);
        this.curLen += 1 + tc.length;
      }
      rel = tsMs - this.clusterTs;
      const block = new Uint8Array(4 + data.length);
      block[0] = 0x81;
      block[1] = 0x40 | ((rel >> 8) & 0x3F);
      block[2] = rel & 0xFF;
      block[3] = keyFrame ? 0x80 : 0x00;
      block.set(data, 4);
      this.cur.push(idBytes("A3"), vint(block.length), block);
      this.curLen += 1 + vintLen(block.length) + block.length;
      this.lastTs = tsMs;
      this.durationSec = tsMs / 1000;
    }
    _closeCluster() {
      if (!this.cur) return;
      this.parts.push(idBytes("1F43B675"), vint(this.curLen), ...this.cur);
      this.cur = null;
    }
    finalize() {
      this._closeCluster();
      new DataView(this.durPart.buffer).setFloat64(0, this.durationSec, false);
      let total = 0;
      for (const p of this.parts) total += p.length;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const p of this.parts) { out.set(p, pos); pos += p.length; }
      return out;
    }
  }

  return { Muxer };
})();
