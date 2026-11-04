
/* ======================================================================
   [LESIONES] Capa añadida (no forma parte del viewer.js original).
   Pinta en rojo/naranja las mallas reales del body.glb, atenúa el resto,
   encuadra la cámara y proyecta rótulos sobre el modelo.
   ====================================================================== */
export const hooks = {};
let modelIsReady = false, pendingSpec = null, activeSpec = null;
const lm = new Map();          // uuid -> material original (antes de la capa)
const boxes = new Map();       // uuid -> Box3 en coordenadas de mundo
const matCache = new Map();    // clave -> material compartido
const pulse = { dmg: [], risk: [] };
let labelItems = [], markers = [];
const zones = new Map(); // mesh -> [{p,r,role}]
const SIDE_DIR = { r: -1, l: 1 }; // paciente derecho = -X (frente = +Z), comprobado con las vistas guardadas de Z-Anatomy

export function start() { if (!renderer) init(); }

function modelReady() {
    modelIsReady = true;
    scene.updateMatrixWorld(true);
    clickableObjects.forEach(o => boxes.set(o.uuid, new THREE.Box3().setFromObject(o)));
    if (pendingSpec) { const p = pendingSpec; pendingSpec = null; setLesion(p); }
    if (hooks.onReady) hooks.onReady();
}

const ctr = o => boxes.get(o.uuid).getCenter(new THREE.Vector3());
function sideOf(o) { const x = ctr(o).x; return Math.abs(x) < 0.012 ? 0 : (x < 0 ? 'r' : 'l'); }
function pickMeshes(rx, side) {
    if (!rx) return [];
    const re = new RegExp(rx, 'i');
    return clickableObjects.filter(o => {
        if (!re.test(o.name.replace(/_/g, ' '))) return false; // GLTFLoader cambia espacios por _ y quita los puntos
        const s = sideOf(o);
        return s === 0 || s === side;
    });
}
function unionBox(list) {
    const b = new THREE.Box3();
    list.forEach(o => b.union(boxes.get(o.uuid)));
    return b;
}
function variant(orig, key, make) {
    const k = orig.uuid + key;
    let m = matCache.get(k);
    if (!m) { m = orig.clone(); make(m); matCache.set(k, m); }
    return m;
}

function zonePaint(o, orig, zs) {
    const g = o.geometry, pos = g.attributes.position, n = pos.count, col = new Float32Array(n * 3);
    const base = orig.color || new THREE.Color(0xe8dcc0), v = new THREE.Vector3(), c = new THREE.Color();
    o.updateWorldMatrix(true, false);
    const mw = o.matrixWorld, cr = new THREE.Color(0xff2d3d), co = new THREE.Color(0xffa21f);
    for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        let w = 0, zc = cr;
        for (const z of zs) {
            const d = v.distanceTo(z.p), t = Math.min(1, (1 - THREE.MathUtils.smoothstep(d, z.r * 0.75, z.r * 1.15)) * 1.15);
            if (t > w) { w = t; zc = z.role === 'risk' ? co : cr; }
        }
        c.copy(base).lerp(zc, w);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = orig.clone(); m.color = new THREE.Color(0xffffff); m.vertexColors = true; m.emissive = new THREE.Color(0x2a0008); m.emissiveIntensity = 1; m.needsUpdate = true;
    return m;
}
function restoreMaterials() {
    lm.forEach((mat, uuid) => {
        const o = clickableObjects.find(x => x.uuid === uuid);
        if (o) { o.material = mat; o.visible = true; }
    });
    lm.clear(); pulse.dmg = []; pulse.risk = []; zones.clear();
    markers.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }); markers = [];
    clickableObjects.forEach(o => { o.visible = true; });
}

function clearLabels() {
    const box = document.getElementById('z3-labels');
    if (box) box.innerHTML = '';
    labelItems = [];
}

export function clearLesion() {
    activeSpec = null; pendingSpec = null;
    if (!modelIsReady) return;
    clearLabels();
    restoreMaterials();
}

export function setLesion(spec) {
    if (!modelIsReady) { pendingSpec = spec; return; }
    // limpia selección/animaciones del visor original
    if (highlightedObject) { unhighlightObject(highlightedObject); highlightedObject = null; }
    closeInfoPanel();
    clearLabels(); restoreMaterials();
    activeSpec = spec;
    const side = spec.side || 'r';
    const dmgSet = new Set(), riskSet = new Set(), pins = [], all = [];
    spec.items.forEach(it => {
        const ms = pickMeshes(it.rx, side);
        const anchor = it.an ? pickMeshes(it.an, side) : ms;
        ms.forEach(o => (it.role === 'risk' ? riskSet : dmgSet).add(o));
        ms.concat(anchor).forEach(o => all.push(o));
        if (!anchor.length) return;
        const b = unionBox(anchor), sz = b.getSize(new THREE.Vector3());
        const f = it.f || [0.5, 0.5, 0.5];
        const lat = SIDE_DIR[side];
        const p = new THREE.Vector3(
            lat < 0 ? b.max.x - f[0] * sz.x : b.min.x + f[0] * sz.x,
            b.min.y + f[1] * sz.y,
            b.min.z + f[2] * sz.z);
        pins.push({ p, role: it.role || 'dmg', lab: it.lab, ms });
        const role = it.role || 'dmg';
        if (it.zr && it.rx && ms.length) {
            ms.forEach(o => { if (!zones.has(o)) zones.set(o, []); zones.get(o).push({ p, r: it.zr, role }); });
        }
        if (!it.rx || !ms.length) { // estructura sin malla propia (ligamento, menisco, disco, nervio…): marcador 3D
            const mk = new THREE.Mesh(new THREE.SphereGeometry(it.zr || 0.018, 20, 14),
                new THREE.MeshBasicMaterial({ color: role === 'risk' ? 0xffa21f : 0xff2d3d, transparent: true, opacity: 0.7, depthTest: false }));
            mk.position.copy(p); mk.renderOrder = 20; mk.userData.mk = true; scene.add(mk); markers.push(mk);
        }
    });
    zones.forEach((z, o) => { dmgSet.delete(o); riskSet.delete(o); });
    const inv = new Set([...dmgSet, ...riskSet]);
    const zset = new Set(zones.keys());
    // región de contexto
    const ub = unionBox(all.length ? all : clickableObjects.slice(0, 1));
    pins.forEach(pn => ub.expandByPoint(pn.p));
    const usz = ub.getSize(new THREE.Vector3());
    const rad = Math.max(0.14, Math.max(usz.x, usz.y, usz.z) * 0.55);
    const ctx = ub.clone().expandByScalar(rad);
    clickableObjects.forEach(o => {
        const orig = o.material;
        lm.set(o.uuid, orig);
        const type = o.userData && o.userData.type;
        if (zones.has(o)) {
            o.material = zonePaint(o, orig, zones.get(o));
            o.visible = true;
            return;
        }
        if (inv.has(o)) {
            const role = dmgSet.has(o) ? 'dmg' : 'risk';
            o.material = variant(orig, role, m => {
                m.color = new THREE.Color(role === 'dmg' ? 0xff2d3d : 0xffa21f);
                m.emissive = new THREE.Color(role === 'dmg' ? 0xb00018 : 0x8a4a00);
                m.emissiveIntensity = 0.6; m.transparent = false; m.opacity = 1;
            });
            pulse[role].push(o.material);
            o.visible = true;
            return;
        }
        if (zset.has(o)) return;
        const s = sideOf(o), near = ctx.containsPoint(ctr(o)) && (s === 0 || s === side);
        if (type === 'bone') {
            const op = near ? (spec.ctxOp || 0.4) : 0.06;
            o.material = variant(orig, 'g' + op, m => { m.transparent = true; m.opacity = op; m.depthWrite = false; });
            o.visible = true;
        } else if (type === 'muscle' && near && spec.muscles) {
            o.material = variant(orig, 'gm', m => { m.transparent = true; m.opacity = 0.28; m.depthWrite = false; });
            o.visible = true;
        } else {
            o.visible = false;
        }
    });
    // rótulos
    const box = document.getElementById('z3-labels');
    if (box && spec.labels !== false) {
        pins.forEach(pn => {
            const el = document.createElement('div');
            el.className = 'z3l ' + pn.role;
            el.innerHTML = '<i></i><span></span>';
            el.lastChild.textContent = pn.lab;
            box.appendChild(el);
            labelItems.push({ el, p: pn.p });
        });
    }
    frameBox(ub, spec.view || 'a', side, spec.zoom || 1);
}

export function frameBox(b, view, side, zoom) {
    const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const md = Math.max(sz.x, sz.y, sz.z, 0.12);
    const fov = camera.fov * Math.PI / 180;
    const dist = Math.max(0.28, (md / 2) / Math.tan(fov / 2) * 1.5) / (zoom || 1);
    const lat = SIDE_DIR[side || 'r'];
    const dirs = { a: [0.12 * -lat, 0.06, 1], p: [0.12 * lat, 0.06, -1], l: [lat, 0.05, 0.1], m: [-lat, 0.05, 0.1] };
    const d = new THREE.Vector3(...(dirs[view] || dirs.a)).normalize().multiplyScalar(dist);
    tweenCam(c.clone().add(d), c);
}
function tweenCam(pos, tgt) {
    const from = { px: camera.position.x, py: camera.position.y, pz: camera.position.z, tx: controls.target.x, ty: controls.target.y, tz: controls.target.z };
    new TWEEN.Tween(from).to({ px: pos.x, py: pos.y, pz: pos.z, tx: tgt.x, ty: tgt.y, tz: tgt.z }, 750)
        .easing(TWEEN.Easing.Cubic.InOut)
        .onUpdate(() => { camera.position.set(from.px, from.py, from.pz); controls.target.set(from.tx, from.ty, from.tz); })
        .start();
}
export function homeView() {
    if (!modelIsReady) return;
    const b = new THREE.Box3();
    clickableObjects.forEach(o => b.union(boxes.get(o.uuid)));
    const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const fov = camera.fov * Math.PI / 180, md = Math.max(sz.x, sz.y, sz.z);
    const dd = Math.abs(md / 2 / Math.tan(fov / 2)) * 1.25;
    tweenCam(c.clone().add(new THREE.Vector3(0.25, 0.1, 1).normalize().multiplyScalar(dd)), c);
}
export function focus(rx, side, view, zoom) {
    if (!modelIsReady) return;
    const ms = pickMeshes(rx, side || 'r');
    if (ms.length) frameBox(unionBox(ms), view || 'a', side || 'r', zoom || 1);
}

function afterRender() {
    const t = performance.now() / 380;
    const k = 0.55 + 0.35 * Math.sin(t);
    markers.forEach(m => { const sc = 1 + 0.18 * Math.sin(t); m.scale.setScalar(sc); });
    pulse.dmg.forEach(m => { m.emissiveIntensity = k; });
    pulse.risk.forEach(m => { m.emissiveIntensity = 0.45 + 0.25 * Math.sin(t); });
    if (!labelItems.length) return;
    const w = cw(), h = ch(), v = new THREE.Vector3(), rows = [];
    labelItems.forEach(it => {
        v.copy(it.p).project(camera);
        const vis = v.z < 1 && v.z > -1;
        it.el.style.display = vis ? '' : 'none';
        if (!vis) return;
        rows.push({ it, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h });
    });
    rows.sort((a, b) => a.y - b.y);
    let last = -99;
    rows.forEach(r => {
        let ly = r.y; if (ly - last < 17) ly = last + 17; last = ly;
        const flip = r.x + 18 + (r.it.el.lastChild.offsetWidth || 90) > w;
        const e = r.it.el;
        e.style.transform = 'translate(' + r.x + 'px,' + ly + 'px)';
        e.classList.toggle('flip', flip);
        e.firstChild.style.transform = 'translate(' + (-4) + 'px,' + (r.y - ly - 4) + 'px)';
    });
}

export function setSideSign(s) { SIDE_DIR.r = s < 0 ? -1 : 1; SIDE_DIR.l = -SIDE_DIR.r; }
export const api = { start, setLesion, clearLesion, homeView, hooks, frameBox, focus,
    reset: () => resetAllObjects(), get ready() { return modelIsReady; },
    get active() { return activeSpec; } };
