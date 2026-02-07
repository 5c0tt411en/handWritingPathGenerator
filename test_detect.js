// ArUcoマーカー検出 - 全画像一括テスト
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

global.CV = {};
global.AR = {};
global.this = global;
eval(fs.readFileSync(path.join(__dirname, 'cv.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, 'aruco2.js'), 'utf8'));

const validIds = new Set([0, 1, 2, 3]);

function countUniqueIds(markers) {
    return new Set(markers.filter(m => validIds.has(m.id)).map(m => m.id)).size;
}

function deduplicateMarkers(markers) {
    const byId = {};
    for (const marker of markers) {
        if (!validIds.has(marker.id)) continue;
        const existing = byId[marker.id];
        if (!existing || (marker.hammingDistance || 0) < (existing.hammingDistance || 0)) {
            byId[marker.id] = marker;
        }
    }
    return Object.values(byId);
}

async function testImage(imgPath) {
    const name = path.basename(imgPath, '.png');
    const img = await loadImage(imgPath);

    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);

    const detector = new AR.Detector({
        dictionaryName: 'ARUCO',
        maxHammingDistance: 3
    });

    const thresholdParams = [
        { k: 2, t: 7 },
        { k: 4, t: 10 },
        { k: 7, t: 15 },
        { k: 10, t: 20 },
    ];

    const bestMarkerById = {};
    function updateBest(markers, label) {
        for (const marker of markers) {
            if (!validIds.has(marker.id)) continue;
            const existing = bestMarkerById[marker.id];
            if (!existing || (marker.hammingDistance || 0) < (existing.hammingDistance || 0)) {
                bestMarkerById[marker.id] = { ...marker, _method: label };
            }
        }
    }

    // Phase 1a: adaptive threshold
    for (const params of thresholdParams) {
        const label = `adaptive(k=${params.k},t=${params.t})`;
        const markers = detector.detect(imageData, {
            adaptiveKernelSize: params.k,
            adaptiveThreshold: params.t
        });
        updateBest(markers, label);
        const uniqueCount = countUniqueIds(markers);
        if (uniqueCount >= 4) {
            const ids = deduplicateMarkers(markers).map(m => m.id).sort();
            return { name, status: 'OK', method: label, ids };
        }
    }

    // Phase 1b: Otsu
    const otsuMarkers = detector.detect(imageData, { useGlobalThreshold: true });
    updateBest(otsuMarkers, 'Otsu');
    if (countUniqueIds(otsuMarkers) >= 4) {
        const ids = deduplicateMarkers(otsuMarkers).map(m => m.id).sort();
        return { name, status: 'OK', method: 'Otsu', ids };
    }

    // Check merged
    const mergedIds = Object.keys(bestMarkerById).map(Number).sort();
    if (mergedIds.length >= 4) {
        const methods = [...new Set(Object.values(bestMarkerById).map(m => m._method))];
        return { name, status: 'OK(merged)', method: methods.join('+'), ids: mergedIds };
    }

    return { name, status: 'FAIL', method: '-', ids: mergedIds, missing: [0,1,2,3].filter(id => !bestMarkerById[id]) };
}

async function main() {
    const dir = path.join(__dirname, 'assets/data/scan_raw_color');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();

    console.log(`Testing ${files.length} images...\n`);

    let okCount = 0, failCount = 0;
    const failures = [];

    for (const file of files) {
        const result = await testImage(path.join(dir, file));
        const statusMark = result.status.startsWith('OK') ? '✓' : '✗';
        const line = `${statusMark} ${result.name.padEnd(25)} ${result.status.padEnd(12)} IDs:[${result.ids.join(',')}] method: ${result.method}`;
        console.log(line);

        if (result.status.startsWith('OK')) {
            okCount++;
        } else {
            failCount++;
            failures.push(result);
        }
    }

    console.log(`\n--- Summary ---`);
    console.log(`OK: ${okCount}/${files.length}, FAIL: ${failCount}/${files.length}`);
    if (failures.length > 0) {
        console.log('\nFailed images:');
        for (const f of failures) {
            console.log(`  ${f.name}: missing IDs [${f.missing.join(',')}]`);
        }
    }
}

main().catch(console.error);
