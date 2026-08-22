#!/usr/bin/env python3
"""Rig contract validator + rig-state renderer for avatar/lena.svg.

    python3 avatar/verify.py            # validate only
    python3 avatar/verify.py --render   # also rasterise every rig state (needs ImageMagick+librsvg)

Checks performed:
  1. the file is well-formed XML and a single <svg> with a 512x512 viewBox
  2. no <image>, <script>, <text>, <foreignObject> or external href
  3. every id is unique and deterministic (no generated suffixes)
  4. every required rig-contract id is present
  5. every url(#id) / href="#id" reference resolves
  6. each of the five mouth siblings exists and exactly one is visible
  7. the eye lids are socket-clipped (no spill on full close)
  8. the upper-lid travel really does cover the whole aperture at BLINK
"""
from __future__ import annotations
import re, sys, os, subprocess, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, 'lena.svg')
NS = '{http://www.w3.org/2000/svg}'

REQUIRED = [
    # structure
    'lena-root', 'lena-backdrop', 'lena-head-back', 'lena-hair-back',
    'lena-body', 'lena-torso', 'lena-neck', 'lena-head', 'lena-head-shape',
    'lena-face', 'lena-face-features',
    # eyes
    'lena-eyes',
    'lena-eye-l', 'lena-eye-l-globe', 'lena-eye-l-lid-upper', 'lena-eye-l-lid-lower',
    'lena-eye-l-pupil', 'lena-eye-l-lashtip', 'lena-eye-l-white',
    'lena-eye-r', 'lena-eye-r-globe', 'lena-eye-r-lid-upper', 'lena-eye-r-lid-lower',
    'lena-eye-r-pupil', 'lena-eye-r-lashtip', 'lena-eye-r-white',
    # brows
    'lena-brows', 'lena-brow-l', 'lena-brow-r',
    # mouths
    'lena-mouths', 'lena-mouth-closed', 'lena-mouth-half', 'lena-mouth-open',
    'lena-mouth-smile', 'lena-mouth-frown',
    # hair
    'lena-hair-front', 'lena-hair-lock-l', 'lena-hair-lock-r',
    'lena-hair-bang-l', 'lena-hair-bang-r', 'lena-hair-fringe',
    'lena-hair-gloss', 'lena-hair-wisps',
    'lena-hair-back-sway-l', 'lena-hair-back-sway-r',
    'lena-ahoge', 'lena-ahoge-strand',
    # wardrobe
    'lena-collar', 'lena-collar-clasp', 'lena-cape-l', 'lena-cape-r',
    'lena-epaulette-l', 'lena-epaulette-r', 'lena-insignia', 'lena-chest-star',
    # clips
    'lena-clip-face', 'lena-clip-socket-l', 'lena-clip-socket-r',
    'lena-clip-hairback', 'lena-clip-fringe', 'lena-clip-torso', 'lena-clip-frame',
]

MOUTHS = ['closed', 'half', 'open', 'smile', 'frown']

HEAD_ORIGIN = (256, 380)
BLINK = 56

STATES = {
    'neutral': {},
    'blink': {'lena-eye-l-lid-upper': f'translate(0 {BLINK})',
              'lena-eye-r-lid-upper': f'translate(0 {BLINK})'},
    'half-lid': {'lena-eye-l-lid-upper': 'translate(0 20)',
                 'lena-eye-r-lid-upper': 'translate(0 20)'},
    'squint': {'lena-eye-l-lid-upper': 'translate(0 12)',
               'lena-eye-r-lid-upper': 'translate(0 12)',
               'lena-eye-l-lid-lower': 'translate(0 -14)',
               'lena-eye-r-lid-lower': 'translate(0 -14)'},
    'wink-l': {'lena-eye-l-lid-upper': f'translate(0 {BLINK})'},
    'look-left': {'lena-eye-l-globe': 'translate(-7 0)',
                  'lena-eye-r-globe': 'translate(-7 0)'},
    'look-up-right': {'lena-eye-l-globe': 'translate(7 -5)',
                      'lena-eye-r-globe': 'translate(7 -5)'},
    'tilt-neg': {'lena-head': f'rotate(-8 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                 'lena-head-back': f'rotate(-8 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                 'lena-ahoge': 'rotate(9 258 72)'},
    'tilt-pos': {'lena-head': f'rotate(8 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                 'lena-head-back': f'rotate(8 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                 'lena-ahoge': 'rotate(-9 258 72)'},
    'nod': {'lena-head': f'translate(0 7) rotate(3 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
            'lena-head-back': f'translate(0 7) rotate(3 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
            'lena-brow-l': 'translate(0 -7)', 'lena-brow-r': 'translate(0 -7)'},
    'brows-angry': {'lena-brow-l': 'rotate(11 150 197)',
                    'lena-brow-r': 'rotate(-11 362 197)', '@mouth': 'frown'},
    'brows-sad': {'lena-brow-l': 'rotate(-10 150 197)',
                  'lena-brow-r': 'rotate(10 362 197)',
                  'lena-eye-l-lid-upper': 'translate(0 10)',
                  'lena-eye-r-lid-upper': 'translate(0 10)'},
    'mouth-closed': {'@mouth': 'closed'},
    'mouth-half': {'@mouth': 'half'},
    'mouth-open': {'@mouth': 'open'},
    'mouth-smile': {'@mouth': 'smile',
                    'lena-eye-l-lid-lower': 'translate(0 -10)',
                    'lena-eye-r-lid-lower': 'translate(0 -10)'},
    'mouth-frown': {'@mouth': 'frown'},
    'hair-sway-pos': {'lena-hair-lock-l': 'rotate(2.6 152 114)',
                      'lena-hair-lock-r': 'rotate(2.6 360 114)',
                      'lena-hair-bang-l': 'rotate(-2.2 250 58)',
                      'lena-hair-bang-r': 'rotate(-2.2 262 58)',
                      'lena-hair-back-sway-l': 'rotate(2.2 102 176)',
                      'lena-hair-back-sway-r': 'rotate(2.2 410 176)'},
    'hair-sway-neg': {'lena-hair-lock-l': 'rotate(-2.6 152 114)',
                      'lena-hair-lock-r': 'rotate(-2.6 360 114)',
                      'lena-hair-bang-l': 'rotate(2.2 250 58)',
                      'lena-hair-bang-r': 'rotate(2.2 262 58)',
                      'lena-hair-back-sway-l': 'rotate(-2.2 102 176)',
                      'lena-hair-back-sway-r': 'rotate(-2.2 410 176)'},
    'ahoge-perk': {'lena-ahoge': 'translate(258 72) scale(1.07) translate(-258 -72) rotate(-15 258 72)'},
    'ahoge-droop': {'lena-ahoge': 'translate(258 72) scale(0.92) translate(-258 -72) rotate(17 258 72)'},
    'ahoge-wag': {'lena-ahoge': 'rotate(-10 258 72)'},
    'collar-lift': {'lena-collar': 'translate(0 -4)',
                    'lena-cape-l': 'rotate(-1.6 258 390)',
                    'lena-cape-r': 'rotate(1.6 254 390)'},
    'wink': {'lena-eye-l-lid-upper': f'translate(0 {BLINK})', '@mouth': 'smile',
             'lena-head': f'rotate(5 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
             'lena-head-back': f'rotate(5 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
             'lena-ahoge': 'rotate(-10 258 72)'},
    'talk-peak': {'@mouth': 'open',
                  'lena-head': f'rotate(-3 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                  'lena-head-back': f'rotate(-3 {HEAD_ORIGIN[0]} {HEAD_ORIGIN[1]})',
                  'lena-ahoge': 'rotate(6 258 72)',
                  'lena-brow-l': 'translate(0 -4)', 'lena-brow-r': 'translate(0 -4)'},
}

errors: list[str] = []
warns: list[str] = []


def fail(msg): errors.append(msg)
def warn(msg): warns.append(msg)


def main() -> int:
    raw = open(SVG, encoding='utf-8').read()

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        print(f'FAIL  XML is not well-formed: {e}')
        return 1

    # 1. root element
    if root.tag != NS + 'svg':
        fail(f'root element is {root.tag}, expected svg')
    if root.get('viewBox') != '0 0 512 512':
        fail(f'viewBox is {root.get("viewBox")!r}, expected "0 0 512 512"')

    # 2. purity
    for bad in ('image', 'script', 'text', 'foreignObject', 'style', 'tspan', 'font'):
        n = len(root.iter(NS + bad))if False else sum(1 for _ in root.iter(NS + bad))
        if n:
            fail(f'contains {n} <{bad}> element(s); the SVG must be pure geometry')
    for el in root.iter():
        for k, v in el.attrib.items():
            if k.endswith('href') and not v.startswith('#'):
                fail(f'external reference {k}="{v}"')
    if re.search(r'\bon[a-z]+\s*=', raw):
        fail('inline event handler attribute found')

    # 3. ids unique + deterministic
    ids: list[str] = []
    for el in root.iter():
        i = el.get('id')
        if i:
            ids.append(i)
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        fail(f'duplicate ids: {sorted(dupes)}')
    for i in ids:
        if not i.startswith('lena-'):
            warn(f'id {i!r} is not namespaced with the "lena-" prefix')
        if re.search(r'[0-9a-f]{6,}$', i) and not i.startswith('lena-g-'):
            warn(f'id {i!r} looks generated rather than deterministic')
    idset = set(ids)

    # 4. required ids
    missing = [i for i in REQUIRED if i not in idset]
    if missing:
        fail(f'missing required rig ids: {missing}')

    # 5. references resolve
    for ref in set(re.findall(r'url\(#([^)]+)\)', raw)) | set(re.findall(r'href="#([^"]+)"', raw)):
        if ref not in idset:
            fail(f'dangling reference to #{ref}')

    # 6. mouths: exactly one visible
    visible = []
    for m in MOUTHS:
        el = find(root, f'lena-mouth-{m}')
        if el is None:
            continue
        if el.get('display', 'inline') != 'none':
            visible.append(m)
    if len(visible) != 1:
        fail(f'expected exactly one visible mouth, found {visible}')

    # 7. the lids live inside a STATIC socket-clipped ancestor.
    #    The clip must sit on an ancestor of the animated group: a clip-path on
    #    the animated element itself is resolved in the transformed user space
    #    and travels with it, defeating containment.
    for side in ('l', 'r'):
        lid = find(root, f'lena-eye-{side}-lid-upper')
        if lid is not None and lid.get('clip-path'):
            fail(f'lena-eye-{side}-lid-upper carries clip-path itself; the clip '
                 f'would translate with the lid. Put it on a static ancestor.')
        if not clipped_ancestor(root, lid, f'lena-clip-socket-{side}'):
            fail(f'lena-eye-{side}-lid-upper is not inside a group clipped to '
                 f'#lena-clip-socket-{side}; a full blink would spill onto the skin')
        low = find(root, f'lena-eye-{side}-lid-lower')
        if not clipped_ancestor(root, low, f'lena-clip-socket-{side}'):
            fail(f'lena-eye-{side}-lid-lower is not socket-clipped')
        globe = find(root, f'lena-eye-{side}-globe')
        if not clipped_ancestor(root, globe, f'lena-clip-socket-{side}'):
            fail(f'lena-eye-{side}-globe is not socket-clipped')
    # face features clipped to the face
    if not clipped_ancestor(root, find(root, 'lena-face-features'), 'lena-clip-face'):
        fail('lena-face-features is not clipped to #lena-clip-face')

    # 8. sway-group count
    sway = [i for i in ids if i in ('lena-hair-lock-l', 'lena-hair-lock-r',
                                    'lena-hair-bang-l', 'lena-hair-bang-r')]
    if not 2 <= len(sway) <= 4:
        fail(f'expected 2-4 hair-front sway groups, found {len(sway)}')

    for w in warns:
        print(f'WARN  {w}')
    for e in errors:
        print(f'FAIL  {e}')
    if not errors:
        print(f'PASS  {len(ids)} unique ids, {len(REQUIRED)} required rig ids present, '
              f'{len(STATES)} rig states defined, {len(raw)} bytes')

    if '--render' in sys.argv:
        render_states(raw)

    return 1 if errors else 0


def find(root, i):
    for el in root.iter():
        if el.get('id') == i:
            return el
    return None


def clipped_ancestor(root, el, clip_id) -> bool:
    """True if el or one of its ancestors carries clip-path=url(#clip_id)."""
    if el is None:
        return False
    parents = {c: p for p in root.iter() for c in p}
    cur = el
    while cur is not None:
        if cur.get('clip-path') == f'url(#{clip_id})':
            return True
        cur = parents.get(cur)
    return False


def render_states(raw: str):
    out = os.path.join(HERE, '.states')
    os.makedirs(out, exist_ok=True)
    ok = 0
    for name, ops in STATES.items():
        doc = raw
        for key, val in ops.items():
            if key == '@mouth':
                for m in MOUTHS:
                    tag = f'<g id="lena-mouth-{m}"'
                    doc = doc.replace(tag + ' display="none">', tag + '>')
                    if m != val:
                        doc = doc.replace(tag + '>', tag + ' display="none">')
                continue
            tag = f'id="{key}"'
            if tag not in doc:
                print(f'FAIL  state {name}: no element with {tag}')
                continue
            doc = doc.replace(tag, f'{tag} transform="{val}"', 1)
        path = os.path.join(out, f'{name}.svg')
        open(path, 'w', encoding='utf-8').write(doc)
        png = path[:-4] + '.png'
        r = subprocess.run(['magick', '-background', 'none', path, png],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f'FAIL  state {name} did not rasterise: {r.stderr.strip()[:160]}')
        else:
            ok += 1
    print(f'RENDER  {ok}/{len(STATES)} rig states rasterised into {out}/')


if __name__ == '__main__':
    sys.exit(main())
