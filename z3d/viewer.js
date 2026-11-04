/* Z-Anatomy viewer — código del usuario (viewer.js) INTEGRADO; cambios mínimos marcados con [ADAPT].
   Modelo: body.glb (Z-Anatomy, CC BY-SA 4.0). Capa de lesiones añadida al final del archivo. */
import * as THREE from 'three';
import './libs/tween.js'; // [ADAPT] tween.js (UMD) define globalThis.TWEEN; antes era <script src>
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/DRACOLoader.js';

let scene, camera, renderer, controls;
let raycaster, mouse;
let clickableObjects = [];
let highlightedObject = null;
let movedObjects = new Map(); // uuid -> { object, material, position, underneathUUIDs: [] }
let originalPositions = new Map(); // uuid -> original position
let visibleTypes = new Set(['muscle', 'bone', 'bursa', 'ligament', 'tendon', 'artery', 'vein', 'nerve']); // Currently visible types
let axesHelper;
const PILE_Y = -1.5; // Feet level for piles
const PILE_RADIUS = 0.3; // Pile radius
let container; // [ADAPT] contenedor del canvas (en vez de la ventana)
const cw = () => container.clientWidth || 300;
const ch = () => container.clientHeight || 300;

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    container = document.getElementById('canvas-container');
    camera = new THREE.PerspectiveCamera(75, cw() / ch(), 0.1, 1000);
    camera.position.set(5, 5, 5);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(cw(), ch());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    scene.add(directionalLight);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-10, -10, -5);
    scene.add(directionalLight2);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 0.12; // [ADAPT] antes 1: para poder acercarse a mano/pie
    controls.maxDistance = 50;

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Add axes helper with labels
    axesHelper = new THREE.Group();
    axesHelper.visible = false;

    const axes = new THREE.AxesHelper(2);
    axesHelper.add(axes);

    // Add labels (X=red, Y=green, Z=blue)
    axesHelper.add(createAxisLabel('X', 2.2, 0, 0, 0xff0000));
    axesHelper.add(createAxisLabel('Y', 0, 2.2, 0, 0x00ff00));
    axesHelper.add(createAxisLabel('Z', 0, 0, 2.2, 0x0000ff));

    scene.add(axesHelper);

    loadModel();

    window.addEventListener('resize', onWindowResize);
    if (window.ResizeObserver) new ResizeObserver(onWindowResize).observe(container); // [ADAPT]
    renderer.domElement.addEventListener('click', onMouseClick);
    document.getElementById('close-btn').addEventListener('click', closeInfoPanel);
    document.getElementById('reset-btn').addEventListener('click', resetAllObjects);
    document.getElementById('toggle-muscles').addEventListener('click', () => toggleType('muscle'));
    document.getElementById('toggle-bones').addEventListener('click', () => toggleType('bone'));
    document.getElementById('toggle-axes').addEventListener('click', toggleAxes);
    ['bursa', 'ligament', 'tendon', 'artery', 'vein', 'nerve'].forEach(t => { const b = document.getElementById('toggle-' + t + 's'); if (b) b.addEventListener('click', () => toggleType(t)); });

    animate();
}

function loadFromEmbedded(loader, onLoad, onProgress, onError) { // [ADAPT]
    import('./body_b64.js').then(m => {
        const bin = atob(m.default), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        loader.parse(u8.buffer, '', onLoad, onError);
    }).catch(onError);
}

const SOFTCOL = { tendon: 0xf4eedb, ligament: 0xe8d38a, disc: 0x86bff0 };
export const softList = [];
function loadSoft(loader, model) {
    return import('./ligs_b64.js').then(m => new Promise((res, rej) => {
        const bin = atob(m.default), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        loader.parse(u8.buffer, '', (g) => {
            const grp = g.scene; model.add(grp); grp.updateMatrixWorld(true);
            const seen = new Set();
            grp.traverse(o => {
                if (!o.isMesh) return;
                const u = o.userData, t = u.type === 'tendon' ? 'tendon' : 'ligament';
                const disc = /menisc|disc|labrum/i.test(u.name || '') && !/meniscotibial|meniscopatellar/i.test(u.name || '');
                const col = disc ? SOFTCOL.disc : SOFTCOL[t];
                o.material = new THREE.MeshStandardMaterial({ color: col, emissive: new THREE.Color(col).multiplyScalar(0.18), roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
                if (hooks.shade) hooks.shade(o);
                clickableObjects.push(o); originalPositions.set(o.uuid, o.position.clone());
                if (u.name && !seen.has(u.name)) { seen.add(u.name); softList.push({ name: u.name, es: u.nameEs || u.name, latin: u.nameDetail || '', type: t, wiki: u.wikiLink || '' }); }
            });
            res();
        }, rej);
    }));
}

function loadModel() {
    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(new URL('./libs/draco/', import.meta.url).href); // [ADAPT] ruta absoluta
    loader.setDRACOLoader(dracoLoader);

    loadFromEmbedded(loader, // [ADAPT] body.glb va embebido en body_b64.js (la plataforma no sirve archivos .glb)
        (gltf) => {
            const model = gltf.scene;
            scene.add(model);

            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            model.position.sub(center);

            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = camera.fov * (Math.PI / 180);
            const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.5;
            camera.position.set(cameraZ, cameraZ, cameraZ);
            camera.lookAt(0, 0, 0);
            controls.update();

            model.traverse((child) => {
                if (child.isMesh) {
                    if (/bursa/i.test(child.name.replace(/_/g, ' '))) { // bursas: tipo propio, azul translúcido
                        child.userData.type = 'bursa';
                        child.material = child.material.clone();
                        child.material.color = new THREE.Color(0x36c2ff); child.material.emissive = new THREE.Color(0x0a4a7a);
                        child.material.transparent = true; child.material.opacity = 0.7; child.material.depthWrite = false;
                    }
                    clickableObjects.push(child);
                    originalPositions.set(child.uuid, child.position.clone());
                }
            });

            console.log('Model loaded successfully');
            // [ADAPT] segundo modelo: ligamentos, tendones, meniscos y discos exportados del mismo Z-Anatomy (Startup.blend), mismas coordenadas
            loadSoft(loader, model).then(() => modelReady(), () => modelReady()); // [ADAPT] avisa a la capa de lesiones
        },
        (progress) => { if (hooks.onProgress) hooks.onProgress(progress.loaded, progress.total); }, // [ADAPT]
        (error) => { console.error('Error loading model:', error); if (hooks.onError) hooks.onError(error); } // [ADAPT]
    );
}

function onWindowResize() {
    if (!container || !container.clientWidth) return; // [ADAPT]
    camera.aspect = cw() / ch();
    camera.updateProjectionMatrix();
    renderer.setSize(cw(), ch());
}

function onMouseClick(event) {
    const rc = renderer.domElement.getBoundingClientRect(); // [ADAPT] coordenadas relativas al canvas
    mouse.x = ((event.clientX - rc.left) / rc.width) * 2 - 1;
    mouse.y = -((event.clientY - rc.top) / rc.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(clickableObjects.filter(o => o.visible), false); // [ADAPT] ignora ocultos

    if (intersects.length > 0) {
        handleObjectClick(intersects[0].object);
    }
}

function handleObjectClick(object) {
    // Clicking moved object -> restore it and objects underneath
    if (movedObjects.has(object.uuid)) {
        restoreObject(object.uuid, true);
        return;
    }

    // Clicking same highlighted object -> move it away
    if (highlightedObject === object) {
        moveObjectAway(object);
        return;
    }

    // Clicking different object -> unhighlight previous, highlight new
    if (highlightedObject) {
        unhighlightObject(highlightedObject);
    }

    highlightObject(object);
}

function highlightObject(object) {
    if (!object.userData.originalMaterial) {
        object.userData.originalMaterial = object.material;
    }

    object.material = object.material.clone();
    object.material.emissive = new THREE.Color(0xff0000);
    object.material.emissiveIntensity = 0.3;

    highlightedObject = object;
    showObjectInfo(object);
}

function unhighlightObject(object) {
    if (object.userData.originalMaterial) {
        object.material = object.userData.originalMaterial;
        delete object.userData.originalMaterial;
    }
}

function getPilePosition(type) {
    const xOffset = type === 'muscle' ? -0.9 : type === 'bone' ? 0.9 : type === 'tendon' ? -1.4 : type === 'ligament' ? 1.4 : type === 'artery' ? -1.9 : type === 'vein' ? 1.9 : type === 'nerve' ? 2.4 : 0;
    return {
        x: xOffset + (Math.random() - 0.5) * PILE_RADIUS * 2,
        y: PILE_Y + Math.random() * 0.2,  // 0.2 units vertical spread
        z: (Math.random() - 0.5) * PILE_RADIUS * 2
    };
}

function moveToPile(object, duration = 800) {
    const pile = getPilePosition(object.userData?.type);
    animateSmoothArc(object, pile, duration);
}

function moveObjectAway(object) {
    if (!object.userData.originalMaterial) return;

    const underneathUUIDs = findObjectsUnderneath(object);

    movedObjects.set(object.uuid, {
        object: object,
        material: object.userData.originalMaterial,
        position: object.position.clone(),
        underneathUUIDs: underneathUUIDs
    });

    object.material = object.material.clone();
    object.material.transparent = true;
    object.material.opacity = 0.3;
    object.material.color.set(0xff0000);
    object.material.emissive = new THREE.Color(0x000000);
    object.material.depthWrite = false;

    moveToPile(object);

    delete object.userData.originalMaterial;
    highlightedObject = null;
}

function findObjectsUnderneath(object) {
    const objectBox = new THREE.Box3().setFromObject(object);
    const underneathUUIDs = [];

    // Check which objects overlap with this one
    clickableObjects.forEach(obj => {
        if (obj.uuid === object.uuid) return;

        const objBox = new THREE.Box3().setFromObject(obj);

        // If bounding boxes intersect, object is underneath
        if (objectBox.intersectsBox(objBox)) {
            underneathUUIDs.push(obj.uuid);
        }
    });

    return underneathUUIDs;
}

function restoreObject(uuid, shouldHighlight = false) {
    const state = movedObjects.get(uuid);
    if (!state) return;

    const object = state.object;

    if (shouldHighlight && highlightedObject) {
        unhighlightObject(highlightedObject);
    }

    const current = object.position.clone();
    const target = state.position;
    const height = Math.max(current.y, target.y) + 0.5;
    const mid1 = {
        x: current.x * 0.7 + target.x * 0.3,
        y: current.y * 0.5 + height * 0.5,
        z: current.z * 0.7 + target.z * 0.3
    };
    const mid2 = {
        x: current.x * 0.3 + target.x * 0.7,
        y: target.y * 0.5 + height * 0.5,
        z: current.z * 0.3 + target.z * 0.7
    };

    new TWEEN.Tween(object.position)
        .to(mid1, 240)
        .easing(TWEEN.Easing.Sinusoidal.Out)
        .chain(
            new TWEEN.Tween(object.position)
                .to(mid2, 240)
                .easing(TWEEN.Easing.Sinusoidal.InOut)
                .chain(
                    new TWEEN.Tween(object.position)
                        .to(target, 320)
                        .easing(TWEEN.Easing.Sinusoidal.In)
                        .onComplete(() => {
                            object.material = state.material;
                            if (shouldHighlight) {
                                highlightObject(object);
                            }
                        })
                )
        )
        .start();

    movedObjects.delete(uuid);

    state.underneathUUIDs.forEach(underneathUUID => {
        if (movedObjects.has(underneathUUID)) {
            restoreObject(underneathUUID, false);
        }
    });
}

function showObjectInfo(object) {
    const {type, name, nameDetail, nameEs, wikiLink} = object?.userData || {};

    document.getElementById('info-type').textContent = ({ligament: 'ligamento', tendon: 'tendón / fascia', bursa: 'bursa', artery: 'arteria', vein: 'vena', nerve: 'nervio'})[type] || type || '';
    document.getElementById('info-title').textContent = nameEs || name || object.name || 'Unnamed Object';
    document.getElementById('info-detail').textContent = nameEs ? [nameDetail, name].filter(Boolean).join(' · ') : (nameDetail || '');

    const wikiLinkEl = document.getElementById('info-wiki-link');
    if (wikiLink) {
        wikiLinkEl.href = wikiLink;
        wikiLinkEl.style.display = 'block';
    } else {
        wikiLinkEl.style.display = 'none';
    }

    document.getElementById('info-panel').classList.remove('hidden');
    if (hooks.onPick) hooks.onPick(object); // [ADAPT]
}

function closeInfoPanel() {
    document.getElementById('info-panel').classList.add('hidden');
}

function createAxisLabel(text, x, y, z, color) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 64;
    canvas.height = 64;

    context.fillStyle = '#' + color.toString(16).padStart(6, '0');
    context.font = 'bold 48px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(x, y, z);
    sprite.scale.set(0.3, 0.3, 1);

    return sprite;
}

function toggleAxes() {
    const btn = document.getElementById('toggle-axes');
    axesHelper.visible = !axesHelper.visible;
    if (axesHelper.visible) {
        btn.classList.add('active');
    } else {
        btn.classList.remove('active');
    }
}

function toggleType(type) {
    const btn = document.getElementById(`toggle-${type}s`);

    if (visibleTypes.has(type)) {
        visibleTypes.delete(type);
        btn.classList.remove('active');
        hideObjectsOfType(type);
    } else {
        visibleTypes.add(type);
        btn.classList.add('active');
        showObjectsOfType(type);
    }
}

function hideObjectsOfType(type) {
    clickableObjects.forEach(obj => {
        if (obj.userData?.type === type) {
            moveToPile(obj);
        }
    });
}

function showObjectsOfType(type) {
    clickableObjects.forEach(obj => {
        if (obj.userData?.type === type) {
            const originalPos = originalPositions.get(obj.uuid);
            if (originalPos) {
                const movedState = movedObjects.get(obj.uuid);
                const targetPos = movedState ? movedState.position : originalPos;
                animateSmoothArc(obj, targetPos, 800);
            }
        }
    });
}

function animateSmoothArc(object, target, duration) {
    const start = object.position.clone();
    const height = Math.max(start.y, target.y) + 0.5;

    // Create smooth curve with 4 control points
    const curve = new THREE.CatmullRomCurve3([
        start,
        new THREE.Vector3(
            start.x * 0.75 + target.x * 0.25,
            start.y * 0.25 + height * 0.75,
            start.z * 0.75 + target.z * 0.25
        ),
        new THREE.Vector3(
            start.x * 0.25 + target.x * 0.75,
            target.y * 0.25 + height * 0.75,
            start.z * 0.25 + target.z * 0.75
        ),
        new THREE.Vector3(target.x, target.y, target.z)
    ]);

    const tweenObj = { t: 0 };
    new TWEEN.Tween(tweenObj)
        .to({ t: 1 }, duration)
        .easing(TWEEN.Easing.Linear.None)
        .onUpdate(() => {
            const point = curve.getPointAt(tweenObj.t);
            object.position.copy(point);
        })
        .start();
}

function resetAllObjects() {
    if (highlightedObject) {
        unhighlightObject(highlightedObject);
        highlightedObject = null;
    }

    movedObjects.forEach((state) => {
        const originalPos = originalPositions.get(state.object.uuid);
        const isVisible = visibleTypes.has(state.object.userData?.type);

        if (isVisible) {
            animateSmoothArc(state.object, originalPos, 800);
            setTimeout(() => {
                state.object.material = state.material;
            }, 800);
        } else {
            moveToPile(state.object);
            state.object.material = state.material;
        }
    });

    setTimeout(() => movedObjects.clear(), 850);
    closeInfoPanel();
}

function animate() {
    requestAnimationFrame(animate);
    if (!container.isConnected || !container.clientWidth) return; // [ADAPT] pestaña no visible: no dibujar
    controls.update();
    TWEEN.update();
    renderer.render(scene, camera);
    afterRender(); // [ADAPT] rótulos de lesión
}


/* ======================================================================
   [LESIONES] Capa añadida (no forma parte del viewer.js original).
   Pinta en rojo/naranja las mallas reales del body.glb, atenúa el resto,
   encuadra la cámara y proyecta rótulos sobre el modelo.
   ====================================================================== */
export const hooks = {};
export const _dbg = { get scene() { return scene; }, get camera() { return camera; }, get controls() { return controls; } };
let modelIsReady = false, pendingSpec = null, activeSpec = null;
const lm = new Map();          // uuid -> material original (antes de la capa)
const boxes = new Map();       // uuid -> Box3 en coordenadas de mundo
const matCache = new Map();    // clave -> material compartido
const pulse = { dmg: [], risk: [] };
let labelItems = [], markers = [];
const zones = new Map(); // mesh -> [{p,r,role}]
const SIDE_DIR = { r: -1, l: 1 }; // paciente derecho = -X (frente = +Z), comprobado con las vistas guardadas de Z-Anatomy


/* ---------- VASOS Y NERVIOS ----------
   Ni el Z-Anatomy gratuito ni BodyParts3D traen arterias, venas o nervios periféricos de los miembros como malla.
   Se generan como tubos de sección variable (anillos de 16 lados, hasta 220 muestras) siguiendo la trayectoria anatómica,
   con puntos de paso calculados sobre las mallas reales de los huesos del body.glb (misma convención [lateral, alto, anterior]). */
const VCOL = { artery: 0xd0283c, vein: 0x2f62d6, nerve: 0xf1d24a };
export const vesselList = [];
let vesselMeshes = [];
const ORI = /^\^(Humerus|Radius|Ulna|Femur|Tibia|Fibula)/;
const frameCache = new Map();
function longFrame(rx, side) { // eje principal (PCA) de un hueso largo: sigue la inclinación real de la diáfisis
    const key = rx + '|' + side; if (frameCache.has(key)) return frameCache.get(key);
    const ms = pickMeshes(rx, side); if (!ms.length) { frameCache.set(key, null); return null; }
    const P = [], v = new THREE.Vector3();
    ms.forEach(o => { o.updateWorldMatrix(true, false); const pa = o.geometry.attributes.position, st = Math.max(1, Math.floor(pa.count / 2500)); for (let i = 0; i < pa.count; i += st) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); P.push(v.clone()); } });
    const c = new THREE.Vector3(); P.forEach(p => c.add(p)); c.divideScalar(P.length);
    let e = new THREE.Vector3(0, 1, 0);
    for (let it = 0; it < 30; it++) { const n = new THREE.Vector3(); P.forEach(p => { const d = p.clone().sub(c); n.addScaledVector(d, d.dot(e)); }); if (n.lengthSq() < 1e-14) break; e = n.normalize(); }
    if (e.y < 0) e.negate();
    const lat = new THREE.Vector3(SIDE_DIR[side], 0, 0); lat.addScaledVector(e, -lat.dot(e)).normalize();
    const ant = new THREE.Vector3(0, 0, 1); ant.addScaledVector(e, -ant.dot(e)); ant.addScaledVector(lat, -ant.dot(lat)); ant.normalize();
    const ext = ax => { let mn = 1e9, mx = -1e9; P.forEach(p => { const t = p.dot(ax); mn = Math.min(mn, t); mx = Math.max(mx, t); }); return [mn, mx]; };
    const fr = { e, lat, ant, h: ext(e), l: ext(lat), a: ext(ant) };
    frameCache.set(key, fr); return fr;
}
function vPoint(a, side) {
    if (ORI.test(a.rx)) {
        const fr = longFrame(a.rx, side); if (fr) {
            const t = (r, f) => r[0] + (r[1] - r[0]) * f;
            // lateral: f=0 medial, f=1 lateral
            return new THREE.Vector3().addScaledVector(fr.lat, t(fr.l, a.f[0])).addScaledVector(fr.e, t(fr.h, a.f[1])).addScaledVector(fr.ant, t(fr.a, a.f[2]));
        }
    }
    const ms = pickMeshes(a.rx, side); if (!ms.length) return null;
    const b = unionBox(ms), sz = b.getSize(new THREE.Vector3()), f = a.f, lat = SIDE_DIR[side];
    return new THREE.Vector3(lat < 0 ? b.max.x - f[0] * sz.x : b.min.x + f[0] * sz.x, b.min.y + f[1] * sz.y, b.min.z + f[2] * sz.z);
}
function tubeGeo(curve, r0, r1) {
    const L = curve.getLength(), N = Math.max(24, Math.min(240, Math.round(L / 0.004))), S = 16;
    const pts = curve.getSpacedPoints(N), fr = curve.computeFrenetFrames(N, false);
    const pos = [], idx = [];
    for (let i = 0; i <= N + 2; i++) { // anillo 0 y N+2: cierres
        const k = Math.max(0, Math.min(N, i - 1)), t = k / N, cap = (i === 0 || i === N + 2);
        const rad = cap ? 0 : (r0 + (r1 - r0) * t) * (1 + 0.06 * Math.sin(t * 9.4));
        const P = pts[k], Nn = fr.normals[k], Bn = fr.binormals[k];
        for (let j = 0; j < S; j++) {
            const a = j / S * Math.PI * 2, c = Math.cos(a) * rad, s = Math.sin(a) * rad;
            pos.push(P.x + Nn.x * c + Bn.x * s, P.y + Nn.y * c + Bn.y * s, P.z + Nn.z * c + Bn.z * s);
        }
    }
    for (let i = 0; i < N + 2; i++) for (let j = 0; j < S; j++) {
        const a = i * S + j, b = i * S + (j + 1) % S, c = (i + 1) * S + j, d = (i + 1) * S + (j + 1) % S;
        idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
}
export function setVessels(defs) {
    vesselMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); const i = clickableObjects.indexOf(m); if (i >= 0) clickableObjects.splice(i, 1); boxes.delete(m.uuid); });
    vesselMeshes = []; vesselList.length = 0;
    const seen = new Set();
    (defs || []).forEach(d => {
        (d.sides || ['r', 'l']).forEach(side => {
            const P = d.pts.map(a => vPoint(a, side));
            if (P.some(p => !p)) { console.warn('vaso sin ancla', d.name, side); return; }
            const curve = new THREE.CatmullRomCurve3(P, false, 'centripetal');
            const col = VCOL[d.type];
            const m = new THREE.Mesh(tubeGeo(curve, d.r[0] * 1.15, d.r[1] * 1.15),
                new THREE.MeshStandardMaterial({ color: col, emissive: new THREE.Color(col).multiplyScalar(0.16), roughness: d.type === 'nerve' ? 0.7 : 0.4, metalness: 0, side: THREE.DoubleSide }));
            m.name = d.name; m.userData = { type: d.type, name: d.name, nameEs: d.es, nameDetail: d.latin, wikiLink: 'https://en.wikipedia.org/wiki/' + d.name.replace(/ /g, '_') };
            scene.add(m); m.updateMatrixWorld(true);
            clickableObjects.push(m); originalPositions.set(m.uuid, m.position.clone()); boxes.set(m.uuid, new THREE.Box3().setFromObject(m));
            vesselMeshes.push(m);
            if (!seen.has(d.name)) { seen.add(d.name); vesselList.push({ name: d.name, es: d.es, latin: d.latin, type: d.type, info: d.info || '' }); }
        });
    });
}

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
    const dmgSet = new Set(), riskSet = new Set(), pins = [], all = [], foc = new THREE.Box3();
    spec.items.forEach(it => {
        const ms = pickMeshes(it.rx, side);
        const anchor = it.an ? pickMeshes(it.an, side) : ms;
        ms.forEach(o => (it.role === 'risk' ? riskSet : dmgSet).add(o));
        ms.concat(anchor).forEach(o => all.push(o));
        if (!anchor.length) return;
        const f = it.f || [0.5, 0.5, 0.5];
        const p = vPoint({ rx: it.an || it.rx, f }, side) || new THREE.Vector3(); // huesos largos: eje real de la diáfisis (PCA)
        if (it.zr && it.role !== 'risk') { const q = it.zr * 2.4; foc.expandByPoint(p.clone().addScalar(q)); foc.expandByPoint(p.clone().addScalar(-q)); }
        else if (ms.length && it.role !== 'risk' && !/^(artery|vein|nerve)$/.test(ms[0].userData.type || '')) foc.union(unionBox(ms));
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
    const ub = foc.isEmpty() ? unionBox(all.length ? all : clickableObjects.slice(0, 1)) : foc;
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
        } else if ((type === 'artery' || type === 'vein' || type === 'nerve') && near && spec.soft) {
            o.visible = true;
        } else if ((type === 'ligament' || type === 'tendon' || type === 'bursa') && near && spec.soft) {
            o.material = variant(orig, 'gs', m => { m.transparent = true; m.opacity = 0.85; m.depthWrite = false; });
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
export const api = { start, softList, setVessels, vesselList, setLesion, clearLesion, homeView, hooks, frameBox, focus,
    reset: () => resetAllObjects(), get ready() { return modelIsReady; },
    get active() { return activeSpec; } };
