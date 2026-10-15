// CPU and GLSL counterparts for the local (motif) symmetry layer. Keep these
// here so pointer mapping and the renderer use one documented seam.
export const TAU = Math.PI * 2;

export function fract(value) { return value - Math.floor(value); }
export function mod(value, divisor) { return ((value % divisor) + divisor) % divisor; }

// GLSL mat2(c, -s, s, c) is column-major and therefore rotates clockwise for
// positive angles. This intentionally matches the shader.
export function rotateForRenderer(point, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: c * point.x + s * point.y, y: -s * point.x + c * point.y };
}

function radialFold(point, segments, mirror) {
  const radius = Math.hypot(point.x, point.y);
  const wedge = TAU / Math.max(segments, 2);
  let angle = mod(Math.atan2(point.y, point.x) + TAU, wedge);
  if (mirror) angle = Math.abs(angle - wedge * .5);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
function mirrorTile(point, scale) { return { x: Math.abs(fract(point.x * scale) - .5) / scale, y: Math.abs(fract(point.y * scale) - .5) / scale }; }
function radialRing(point, scale) { return Math.floor(Math.hypot(point.x, point.y) * Math.max(2, scale * 2)); }

export function localMotifPoint(point, state = {}) {
  const segments = Math.max(2, Number(state.segments) || 2), scale = segments * .25;
  const twisted = rotateForRenderer(point, Math.hypot(point.x, point.y) * (Number(state.twist) || 0));
  const mode = state.symmetryMode;
  if (mode === "radial") return radialFold(twisted, segments, Boolean(state.mirror));
  if (mode === "mirrorRadial" || mode === "spiral") return radialFold(twisted, segments, true);
  if (mode === "tunnel") { const q = radialFold(twisted, segments, true), rings = Math.max(1, scale), length = Math.hypot(q.x + .00001, q.y); return { x: (q.x + .00001) / length * fract(Math.hypot(q.x, q.y) * rings) / rings, y: q.y / length * fract(Math.hypot(q.x, q.y) * rings) / rings }; }
  if (mode === "fractalFold") { let q = { x: twisted.x * scale, y: twisted.y * scale }; for (let i = 0; i < 3; i += 1) { q = { x: Math.abs(q.x), y: Math.abs(q.y) }; q = rotateForRenderer(q, Math.PI / 3); q = { x: fract(q.x * 1.75) - .5, y: fract(q.y * 1.75) - .5 }; } return { x: q.x / scale, y: q.y / scale }; }
  if (mode === "tile" || mode === "wallpaper") return mirrorTile(twisted, scale);
  if (mode === "p2") return rotateForRenderer(radialFold(twisted, segments, true), mod(radialRing(twisted, scale), 2) * Math.PI);
  if (mode === "p4") return rotateForRenderer(radialFold(twisted, segments, true), mod(radialRing(twisted, scale), 4) * Math.PI * .5);
  if (mode === "pg") { const ring = radialRing(twisted, scale); let q = radialFold(rotateForRenderer(twisted, mod(ring, 2) * TAU / segments * .5), segments, true); if (mod(ring, 2) > .5) q = rotateForRenderer(q, Math.PI); return q; }
  if (mode === "hexagonal") { const q = { x: twisted.x * scale * 1.154700538, y: twisted.y * scale }; q.y += mod(Math.floor(q.x), 2) * .5; q.x = fract(q.x) - .5; q.y = fract(q.y) - .5; q.x *= .866025404; return { x: Math.abs(q.x) / scale, y: Math.abs(q.y) / scale }; }
  return mirrorTile(twisted, scale);
}

export const LOCAL_MOTIF_GLSL = `
vec2 radialFold(vec2 p, bool mirror) { float r=length(p), a=atan(p.y,p.x), wedge=TAU/max(u_segments,2.0); a=mod(a+TAU,wedge); if(mirror) a=abs(a-wedge*.5); return vec2(cos(a),sin(a))*r; }
vec2 twistPoint(vec2 p) { return rotate2d(p,length(p)*u_twist); }
vec2 mirrorTile(vec2 p,float scale) { return abs(fract(p*scale)-.5)/scale; }
float radialRing(vec2 p,float scale) { return floor(length(p)*max(2.0,scale*2.0)); }
vec2 halfTurnTile(vec2 p,float scale) { return rotate2d(radialFold(p,true),mod(radialRing(p,scale),2.0)*PI); }
vec2 quarterTurnTile(vec2 p,float scale) { return rotate2d(radialFold(p,true),mod(radialRing(p,scale),4.0)*PI*.5); }
vec2 glideMirrorTile(vec2 p,float scale) { float wedge=TAU/max(u_segments,2.0), ring=radialRing(p,scale); vec2 q=radialFold(rotate2d(p,mod(ring,2.0)*wedge*.5),true); if(mod(ring,2.0)>.5)q=rotate2d(q,PI); return q; }
vec2 localMotifPoint(vec2 p) { p=twistPoint(p); float scale=max(u_segments,2.0)*.25;
 if(u_symmetryMode==0)return radialFold(p,u_mirror); if(u_symmetryMode==1||u_symmetryMode==2)return radialFold(p,true);
 if(u_symmetryMode==3){vec2 q=radialFold(p,true);float rings=max(1.0,scale);return normalize(q+vec2(.00001,0.))*fract(length(q)*rings)/rings;}
 if(u_symmetryMode==4){vec2 q=p*scale;for(int i=0;i<3;i++){q=abs(q);q=rotate2d(q,PI/3.);q=fract(q*1.75)-.5;}return q/scale;}
 if(u_symmetryMode==5)return mirrorTile(p,scale); if(u_symmetryMode==6)return halfTurnTile(p,scale); if(u_symmetryMode==7)return quarterTurnTile(p,scale); if(u_symmetryMode==8)return glideMirrorTile(p,scale);
 if(u_symmetryMode==9){vec2 q=p*scale;q.x*=1.154700538;q.y+=mod(floor(q.x),2.)*.5;q=fract(q)-.5;q.x*=.866025404;return abs(q)/scale;} return mirrorTile(p,scale); }
`;
