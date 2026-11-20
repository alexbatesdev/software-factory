const MAX_LABELS = 280;
const MAX_LINES = 5000;
const MAX_SOURCE_FILES = 8;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const isFolder = n => n.kind === 'dir' || n.kind === 'ghost_dir';
const changeStyle = {added:['#65d99c','＋'],deleted:['#ee8998','−'],modified:['#e8c46e','~'],renamed:['#7bcbd5','→'],type:['#caa0e9','↔']};
const rgb = c => `rgb(${c.map(v => Math.round(clamp(v, 0, 1) * 255)).join(',')})`;
const intersects = (r, w, h) => r[0] < w && r[1] < h && r[0] + r[2] > 0 && r[1] + r[3] > 0;

export function lineGeometry(node, line, geometry) {
  if (!geometry || !(geometry.columnChars > 0) || !(geometry.charWidth > 0)) throw new Error('The local service did not provide source geometry. Refresh the project or update the analysis binary.');
  const rows = Math.ceil(node.lineCount / Math.max(1, node.cols));
  if (rows < 1 || line < 1 || line > node.lineCount || node.lineHeight <= 0) return null;
  const i = line - 1;
  return [node.inner[0] + Math.floor(i / rows) * geometry.columnChars * geometry.charWidth * node.lineHeight,
    node.inner[1] + (i % rows) * node.lineHeight, geometry.columnChars * geometry.charWidth * node.lineHeight, node.lineHeight];
}

export class MapRenderer {
  constructor(element, callbacks) {
    this.element = element;
    this.canvas = element.querySelector('#geometry');
    this.overlay = element.querySelector('#labels');
    this.ctx = this.overlay.getContext('2d');
    this.callbacks = callbacks;
    this.nodes = [];
    this.sources = new Map();
    this.links = [];
    this.camera = {x: 500, y: 350, scale: 1};
    this.selected = null;
    this.targetLine = null;
    this.stats = {gpu: false, drawCalls: 0, instances: 0, labels: 0, codeLines: 0, sourceCandidates: 0};
    this.width = 1;
    this.height = 1;
    this.pendingFrame = false;
    this.needsFit = true;
    try { this.initGL(); } catch (error) { this.gpuError(error.message); }
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.gl = null;
      this.stats.gpu = false;
      this.gpuError('WebGL context lost. File tree and inspector remain available. Reload to restore the GPU map.');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      try { this.initGL(); this.updateInstances(); this.requestDraw(); }
      catch (error) { this.gpuError(error.message); }
    });
    new ResizeObserver(() => this.resize()).observe(element);
    this.bindPointer();
  }

  initGL() {
    const gl = this.canvas.getContext('webgl2', {alpha: false, antialias: false, preserveDrawingBuffer: true});
    if (!gl) throw new Error('WebGL2 is unavailable. The GPU treemap cannot render in this browser; use the file tree and inspector, or enable WebGL2 and reload.');
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      layout(location=0) in vec2 corner;
      layout(location=1) in vec4 rect;
      layout(location=2) in vec3 color;
      uniform vec2 viewport;
      uniform vec3 camera;
      out vec3 tint;
      out vec2 uv;
      flat out vec2 pixelSize;
      void main(){
        vec2 p=(rect.xy+corner*rect.zw-camera.xy)*camera.z+viewport*0.5;
        gl_Position=vec4(p.x/viewport.x*2.0-1.0,1.0-p.y/viewport.y*2.0,0.0,1.0);
        tint=color; uv=corner; pixelSize=rect.zw*camera.z;
      }`));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec3 tint;
      in vec2 uv;
      flat in vec2 pixelSize;
      out vec4 frag;
      void main(){
        vec2 edge=min(uv,1.0-uv)*pixelSize;
        bool border=min(pixelSize.x,pixelSize.y)>8.0 && min(edge.x,edge.y)<1.0;
        frag=vec4(border ? tint*2.05 : tint,1.0);
      }`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.gl = gl;
    this.program = program;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(2, 1);
    this.viewportUniform = gl.getUniformLocation(program, 'viewport');
    this.cameraUniform = gl.getUniformLocation(program, 'camera');
    this.stats.gpu = true;
    this.element.querySelector('#gpu-error').hidden = true;
    this.callbacks.onGPU?.(true);
  }

  gpuError(message) {
    const el = this.element.querySelector('#gpu-error');
    el.textContent = message; el.hidden = false;
    this.callbacks.onGPU?.(false);
  }

  resize() {
    const rect = this.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const first = this.width === 1;
    this.width = rect.width; this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [this.canvas, this.overlay]) {
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
    }
    if (first || this.needsFit) this.fit();
    this.requestDraw();
  }

  setView(view) {
    if (!view.geometry || !(view.geometry.columnChars > 0) || !(view.geometry.charWidth > 0)) throw new Error('The local service did not provide source geometry. Refresh the project or update the analysis binary.');
    this.view = view;
    this.prFiles = new Map((view.pr?.files || []).map(file => [file.node, file]));
    this.nodes = view.nodes.filter(n => n.visible && n.rect[2] > 0 && n.rect[3] > 0);
    this.updateInstances();
    this.requestDraw();
  }

  clear() {
    this.view = null; this.prFiles = new Map(); this.nodes = []; this.sources = new Map(); this.links = [];
    this.selected = null; this.targetLine = null; this.needsFit = true;
    this.updateInstances(); this.requestDraw();
  }

  updateInstances() {
    this.stats.instances = this.nodes.length;
    if (!this.gl) return;
    const data = new Float32Array(this.nodes.length * 7);
    const search = Boolean(this.view?.searchActive);
    const depths = new Map();
    this.nodes.forEach((n, i) => {
      const pr = this.prFiles?.get(n.id);
      const fade = (search && !n.onPath ? .22 : 1) * (this.view?.pr && !isFolder(n) && pr?.status === 'unchanged' && pr?.impact === 'none' ? .24 : 1);
      const depth = n.parent == null ? 0 : (depths.get(n.parent) || 0) + 1;
      depths.set(n.id, depth);
      const base = n.color || [.25,.3,.35];
      const shade = .07 + .03 * Math.min(depth,5);
      const color = n.kind === 'dir' ? [shade*.85,shade,shade*1.25]
        : n.kind.startsWith('ghost') ? [.1,.09,.08]
        : base.map(c => c * (n.kind === 'binary' ? .35 : n.ignored ? .12 : .17));
      data.set([...n.rect, ...color.map(c => c * fade)], i * 7);
    });
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instances);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.STATIC_DRAW);
  }

  setSources(sources) { this.sources = sources; this.requestDraw(); }
  select(id, line = null) { this.selected = id; this.targetLine = line; this.requestDraw(); }

  screenRect(r) {
    return [(r[0] - this.camera.x) * this.camera.scale + this.width / 2,
      (r[1] - this.camera.y) * this.camera.scale + this.height / 2,
      r[2] * this.camera.scale, r[3] * this.camera.scale];
  }

  worldPoint(x, y) {
    return [(x - this.width / 2) / this.camera.scale + this.camera.x,
      (y - this.height / 2) / this.camera.scale + this.camera.y];
  }

  fit(rect = null) {
    if (!rect) {
      const roots = this.nodes.filter(n => n.parent == null);
      rect = roots[0]?.rect || [0,0,1000,700];
    }
    this.camera = {x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2,
      scale: clamp(Math.min((this.width - 30) / Math.max(rect[2], .001), (this.height - 30) / Math.max(rect[3], .001)), .01, 1e7)};
    this.needsFit = false;
    this.requestDraw();
  }

  flyTo(node, line = null) {
    const r = line == null ? null : lineGeometry(node, line, this.view?.geometry);
    if (r) {
      const scale = clamp(Math.min((this.width - 50) / r[2], 19 / r[3]), .01, 1e7);
      this.camera = {x: r[0] + r[2] / 2, y: r[1] + r[3] / 2, scale};
      this.targetLine = line;
      this.requestDraw();
    } else this.fit(node.rect);
  }

  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const anchor = this.worldPoint(x, y);
    this.camera.scale = clamp(this.camera.scale * factor, .01, 1e7);
    this.camera.x = anchor[0] - (x - this.width / 2) / this.camera.scale;
    this.camera.y = anchor[1] - (y - this.height / 2) / this.camera.scale;
    this.requestDraw();
  }

  requestDraw() {
    if (this.pendingFrame) return;
    this.pendingFrame = true;
    requestAnimationFrame(() => { this.pendingFrame = false; this.draw(); });
  }

  draw() {
    const gl = this.gl;
    if (gl) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(.04,.05,.07,1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program); gl.bindVertexArray(this.vao);
      gl.uniform2f(this.viewportUniform, this.width, this.height);
      gl.uniform3f(this.cameraUniform, this.camera.x, this.camera.y, this.camera.scale);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nodes.length);
      this.stats.drawCalls++;
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.links = []; this.stats.labels = 0; this.stats.codeLines = 0;
    if (!gl) return;
    const candidates = [];
    const visible = [];
    for (const node of this.nodes) {
      const r = this.screenRect(node.rect);
      if (!intersects(r, this.width, this.height) || r[2] < 2 || r[3] < 2) continue;
      visible.push([node, r]);
      if (node.kind === 'text' && node.lineHeight * this.camera.scale >= 1.25 && node.lineCount > 0) {
        candidates.push(node);
      }
    }
    candidates.sort((a,b) => (b.id === this.selected) - (a.id === this.selected) || b.lineHeight - a.lineHeight);
    const sourcesWanted = candidates.slice(0, MAX_SOURCE_FILES);
    const wanted = new Set(sourcesWanted.map(n => n.id));
    this.stats.sourceCandidates = sourcesWanted.length;
    for (const [node, rect] of visible) {
      const source = this.sources.get(node.id);
      const pr = this.prFiles?.get(node.id);
      if(pr && !isFolder(node) && (changeStyle[pr.status] || pr.impact === 'caller'))this.drawChangeOutline(rect,pr);
      if (wanted.has(node.id) && source && !source.message) this.drawCode(node, source);
      if (this.stats.labels < MAX_LABELS && rect[2] > 54 && rect[3] > 18 && node.id !== 0) this.drawLabel(node, rect);
      if (node.id === this.selected) {
        ctx.strokeStyle = '#f4d26d'; ctx.lineWidth = 2;
        ctx.strokeRect(rect[0]+1, rect[1]+1, Math.max(0,rect[2]-2), Math.max(0,rect[3]-2));
      }
    }
    this.callbacks.onSourcesNeeded?.(sourcesWanted.map(n => n.id));
  }

  drawChangeOutline(rect, file) {
    const ctx=this.ctx,style=changeStyle[file.status];
    if(rect[2]<4 || rect[3]<4)return;
    ctx.save();ctx.strokeStyle=style?.[0]||'#8baee8';ctx.lineWidth=style?1.5:1;
    if(!style)ctx.setLineDash([3,3]);
    ctx.strokeRect(rect[0]+.75,rect[1]+.75,Math.max(0,rect[2]-1.5),Math.max(0,rect[3]-1.5));ctx.restore();
  }

  drawLabel(node, rect) {
    const ctx = this.ctx;
    const x = Math.max(rect[0], 0) + 4, y = Math.max(rect[1], 0) + 3;
    const room = Math.min(rect[0] + rect[2] - x - 3, this.width - x);
    if (room < 25) return;
    ctx.save(); ctx.beginPath(); ctx.rect(rect[0],rect[1],rect[2],rect[3]); ctx.clip();
    ctx.font = '11px system-ui';
    const pr=this.prFiles?.get(node.id),prefix=changeStyle[pr?.status]?.[1]||(pr?.impact==='caller'?'◌':'');
    const name=prefix ? `${prefix} ${node.name}` : node.name;
    const chars = Array.from(name);
    const max = Math.max(2, Math.floor(room / 6.2));
    const label = chars.length > max ? chars.slice(0, max-1).join('') + '…' : name;
    ctx.fillStyle = '#080c13dd'; ctx.fillRect(x-2,y-1, Math.min(room,ctx.measureText(label).width+6),15);
    ctx.fillStyle = node.ignored ? '#ccb795' : '#e0e6ef'; ctx.fillText(label, x, y+11);
    ctx.restore(); this.stats.labels++;
  }

  drawCode(node, source) {
    const lh = node.lineHeight * this.camera.scale;
    const cols = Math.max(1, node.cols), rows = Math.ceil(node.lineCount / cols);
    if (!rows || lh <= 0) return;
    const {columnChars, charWidth} = this.view.geometry;
    const inner = this.screenRect(node.inner), ch = charWidth * lh, cw = columnChars * ch;
    const firstCol = clamp(Math.floor(-inner[0] / cw), 0, cols);
    const lastCol = clamp(Math.ceil((this.width - inner[0]) / cw), 0, cols);
    const firstRow = clamp(Math.floor(-inner[1] / lh), 0, rows);
    const lastRow = clamp(Math.ceil((this.height - inner[1]) / lh), 0, rows);
    const ctx = this.ctx;
    const changed = source._changedLines || (source._changedLines = new Set(source.pr?.changedLines || []));
    ctx.save(); ctx.beginPath(); ctx.rect(inner[0], inner[1], inner[2], inner[3]); ctx.clip();
    for (let col=firstCol; col<lastCol; col++) {
      for (let row=firstRow; row<lastRow && this.stats.codeLines < MAX_LINES; row++) {
        const i = col * rows + row;
        if (i >= node.lineCount) break;
        const x = inner[0] + col*cw, y = inner[1] + row*lh;
        if(changed.has(i+1)){ctx.fillStyle=source.pr.side==='before'?'#d8597048':'#43bb8050';ctx.fillRect(x,y,cw,lh);}
        if (node.id === this.selected && i+1 === this.targetLine) {
          ctx.fillStyle = '#f6c95744'; ctx.fillRect(x,y,cw,lh);
          ctx.strokeStyle = '#edc46a'; ctx.lineWidth = 1; ctx.strokeRect(x,y,cw,lh);
        }
        if (lh < 8) {
          const strip = source.strips?.[i];
          if (strip && strip[1]) {
            ctx.fillStyle = strip[2] ? '#54715b' : '#7a8699';
            ctx.fillRect(x + Math.min(strip[0],columnChars)*ch, y + lh*.18, Math.max(.5,Math.min(strip[1],columnChars-strip[0])*ch),Math.max(.5,lh*.64));
          }
          const line = source.lines?.[i];
          for (const link of line?.links || []) {
            const run = this.runColorAt(line, link.start);
            ctx.fillStyle = rgb(run);
            ctx.fillRect(x+Math.min(link.start,columnChars)*ch,y+lh*.18,Math.max(0,Math.min(link.end,columnChars)-link.start)*ch,Math.max(.5,lh*.64));
          }
        } else {
          const line = source.lines?.[i];
          if (line) {
            let column = 0;
            const runs = line.runs?.length ? line.runs : [{text:line.text,color:[.8,.83,.88]}];
            for (const run of runs) {
              const chars = Array.from(run.text);
              const text = chars.slice(0, Math.max(0,columnChars-column)).join('');
              if (!text) break;
              ctx.font = `${lh*.8}px ui-monospace, SFMono-Regular, Menlo, monospace`;
              ctx.fillStyle = rgb(run.color);
              const width = ctx.measureText(text).width;
              ctx.save(); ctx.translate(x+column*ch,y+lh*.79);
              ctx.scale(text.length && width ? Array.from(text).length*ch/width : 1,1);
              ctx.fillText(text,0,0); ctx.restore();
              column += chars.length;
              if (column >= columnChars) break;
            }
            for (const link of line.links || []) {
              const start = clamp(link.start,0,columnChars), end = clamp(link.end,0,columnChars);
              if (end <= start || !link.definition) continue;
              const r = [x+start*ch,y,(end-start)*ch,lh];
              if (intersects(r,this.width,this.height)) this.links.push({rect:r,link});
            }
          }
        }
        this.stats.codeLines++;
      }
    }
    ctx.restore();
  }

  runColorAt(line, column) {
    let c = 0;
    for (const run of line.runs || []) {
      c += Array.from(run.text).length;
      if (column < c) return run.color;
    }
    return [.8,.7,.4];
  }

  hitNode(x, y) {
    const [wx,wy] = this.worldPoint(x,y);
    for (let i=this.nodes.length-1; i>=0; i--) {
      const n = this.nodes[i], r = n.rect;
      if (wx>=r[0] && wy>=r[1] && wx<r[0]+r[2] && wy<r[1]+r[3]) return n;
    }
    return null;
  }

  hitLink(x, y) {
    return this.links.find(({rect:r}) => x>=r[0] && y>=r[1] && x<r[0]+r[2] && y<r[1]+r[3]);
  }

  bindPointer() {
    const el = this.element, tooltip = el.querySelector('#map-tooltip');
    const point = e => { const r=el.getBoundingClientRect(); return [e.clientX-r.left,e.clientY-r.top]; };
    el.addEventListener('wheel', event => {
      event.preventDefault(); tooltip.hidden = true;
      const [x,y] = point(event); this.zoom(Math.exp(-clamp(event.deltaY,-200,200)*.006),x,y);
    },{passive:false});
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      el.focus({preventScroll:true}); el.setPointerCapture(event.pointerId);
      this.drag = {point:point(event), x:this.camera.x, y:this.camera.y, moved:false};
      tooltip.hidden = true;
    });
    el.addEventListener('pointermove', event => {
      const [x,y] = point(event);
      if (this.drag) {
        const dx=x-this.drag.point[0],dy=y-this.drag.point[1];
        if (Math.hypot(dx,dy)>3) this.drag.moved=true;
        if (this.drag.moved) {
          this.camera.x=this.drag.x-dx/this.camera.scale;
          this.camera.y=this.drag.y-dy/this.camera.scale; this.requestDraw();
        }
        return;
      }
      const hit = this.hitLink(x,y), node=this.hitNode(x,y);
      el.style.cursor=hit ? 'pointer' : node ? 'grab' : 'default';
      if (hit) {
        const d=hit.link.definition;
        tooltip.textContent=`${d.name} → ${d.file}:${d.line}\n${hit.link.evidence || 'Source'}${hit.link.reason ? ': '+hit.link.reason : ''}`;
      } else if (node) tooltip.textContent=`${node.path || this.view?.root}\n${isFolder(node) ? `${node.totalFiles} files · ${node.totalLines} lines` : `${node.lineCount} lines`}${node.ignored ? ' · ignored: open to read' : ''}`;
      const pr=node && this.prFiles?.get(node.id);
      if(pr && !hit)tooltip.textContent+=`\n${pr.status}${pr.impact==='caller'?` · Potential caller, ${pr.distance} method hops`:''}${pr.status==='renamed'?`\n${pr.oldPath} → ${pr.newPath}`:''}`;
      tooltip.hidden = !node && !hit;
      tooltip.style.left = `${Math.min(x+12,Math.max(8,this.width-300))}px`;
      tooltip.style.top = `${Math.max(4,Math.min(y+15,this.height-75))}px`;
    });
    el.addEventListener('pointerup', event => {
      if (!this.drag) return;
      const drag=this.drag; this.drag=null;
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
      if (!drag.moved) {
        const [x,y]=point(event), link=this.hitLink(x,y), node=this.hitNode(x,y);
        if (link) this.callbacks.onLink?.(link.link);
        else if (node) this.callbacks.onSelect?.(node.id);
      }
    });
    el.addEventListener('pointercancel', () => {this.drag=null;});
    el.addEventListener('pointerleave', () => {tooltip.hidden=true;});
    el.addEventListener('dblclick', event => {
      const node=this.hitNode(...point(event));
      if (node) this.callbacks.onActivate?.(node.id);
    });
    el.addEventListener('keydown', event => {
      if (event.key==='f' || event.key==='Escape' || event.key==='Home') {this.fit();event.preventDefault();}
      if (event.key==='+' || event.key==='=') {this.zoom(1.5);event.preventDefault();}
      if (event.key==='-') {this.zoom(1/1.5);event.preventDefault();}
      if (event.key==='Enter' && this.selected != null) {this.callbacks.onActivate?.(this.selected);event.preventDefault();}
      const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(direction){this.camera.x+=direction[0]*70/this.camera.scale;this.camera.y+=direction[1]*70/this.camera.scale;this.requestDraw();event.preventDefault();}
    });
  }
}
