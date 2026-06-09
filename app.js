(function () {
  const MODE_A_BUCKETS = [
    { id: "much-worse", label: "Much worse than India average", color: "#8b1e2d" },
    { id: "worse", label: "Worse than India average", color: "#c94f52" },
    { id: "slightly-worse", label: "Slightly worse than India average", color: "#e8a39f" },
    { id: "near", label: "Near India average", color: "#f3efe6" },
    { id: "slightly-better", label: "Slightly better than India average", color: "#b7d8bb" },
    { id: "better", label: "Better than India average", color: "#5fa06a" },
    { id: "best", label: "Best performers", color: "#1e6c3d" },
    { id: "missing", label: "Missing data", color: "#c7c2b8", missing: true },
  ];

  const MODE_B_BUCKETS = [
    { id: "highest-improvement", label: "Highest improvement", color: "#16a34a" },
    { id: "improvement", label: "Improvement", color: "#4c8f48" },
    { id: "no-change", label: "No change", color: "#d7d4ce" },
    { id: "worsened", label: "Worsened", color: "#dcb955" },
    { id: "extremely-worsened", label: "Extremely worsened", color: "#c23d3d" },
    { id: "missing", label: "Missing data", color: "#c7c2b8", missing: true },
  ];

  const TFR_BUCKET = {
    id: "below-replacement",
    label: "Below replacement-level fertility, TFR < 2.1",
  };

  const state = {
    dataset: null,
    geojson: null,
    indicatorsById: new Map(),
    regionsByGeoName: new Map(),
    selectedIndicatorId: null,
    mode: "india",
    activeLegendSelection: null,
  };

  const ui = {
    error: document.querySelector("#app-error"),
    indicatorSelect: document.querySelector("#indicator-select"),
    modeInputs: Array.from(document.querySelectorAll('input[name="mode"]')),
    legendItems: document.querySelector("#legend-items"),
    legendNote: document.querySelector("#legend-note"),
    indicatorDetails: document.querySelector("#indicator-details"),
    selectedStates: document.querySelector("#selected-states"),
    hoverDetails: document.querySelector("#hover-details"),
    clearSelection: document.querySelector("#clear-selection"),
    svg: document.querySelector("#map"),
    tooltip: document.querySelector("#tooltip"),
  };

  function showError(message) {
    ui.error.textContent = message;
    ui.error.classList.remove("hidden");
    ui.indicatorDetails.innerHTML = `<p>${message}</p>`;
    ui.selectedStates.className = "stack muted";
    ui.selectedStates.textContent = "Unable to load the visualisation.";
    ui.hoverDetails.className = "stack muted";
    ui.hoverDetails.textContent = "Unable to load the visualisation.";
    ui.legendItems.innerHTML = "";
    ui.legendNote.textContent = "";
    ui.svg.innerHTML = "";
  }

  function clearError() {
    ui.error.textContent = "";
    ui.error.classList.add("hidden");
  }

  async function fetchJson(relativePath, label) {
    const response = await fetch(relativePath, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`${label} request failed with HTTP ${response.status} for ${relativePath}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${label} is not valid JSON at ${relativePath}: ${error.message}`);
    }
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  function validateDataset(dataset) {
    assert(dataset && typeof dataset === "object", "Indicator dataset is missing or malformed.");
    assert(Array.isArray(dataset.indicators), "Indicator dataset is missing the indicators array.");
    assert(Array.isArray(dataset.regions), "Indicator dataset is missing the regions array.");
    dataset.indicators.forEach((indicator, index) => {
      assert(indicator.id && indicator.display_label, `Indicator ${index + 1} is missing id or display_label.`);
      assert(indicator.polarity === "positive" || indicator.polarity === "negative", `Indicator ${indicator.id} has invalid polarity.`);
    });
  }

  function validateGeojson(geojson) {
    assert(geojson && geojson.type === "FeatureCollection", "Boundary file is not a GeoJSON FeatureCollection.");
    assert(Array.isArray(geojson.features), "Boundary file is missing the features array.");
  }

  function roundToPrecision(value, precision) {
    if (value == null) {
      return null;
    }
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
  }

  function compareAtPrintedPrecision(left, right, precision) {
    if (left == null || right == null) {
      return "missing";
    }
    const a = roundToPrecision(left, precision);
    const b = roundToPrecision(right, precision);
    if (a === b) {
      return "equal";
    }
    return a > b ? "higher" : "lower";
  }

  function formatValue(value, precision, unit) {
    if (value == null) {
      return "NA";
    }
    const fixed = Number(value).toFixed(precision);
    return unit === "%" ? `${fixed}%` : fixed;
  }

  function formatDiff(value, precision, unit) {
    if (value == null) {
      return "NA";
    }
    const sign = value > 0 ? "+" : "";
    const fixed = Number(value).toFixed(precision);
    return unit === "%" ? `${sign}${fixed} pp` : `${sign}${fixed}`;
  }

  function formatNumber(value, digits) {
    if (value == null || !Number.isFinite(value)) {
      return "NA";
    }
    return value.toFixed(digits);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getIndicator(indicatorId) {
    return state.indicatorsById.get(indicatorId || state.selectedIndicatorId);
  }

  function getRegionValue(regionName, indicatorId) {
    const region = state.regionsByGeoName.get(regionName);
    if (!region) {
      return null;
    }
    return region.values[indicatorId || state.selectedIndicatorId] || null;
  }

  function getPolarity(indicator) {
    return indicator.polarity;
  }

  function getGoodnessDiffFromIndia(regionName, indicator) {
    const value = getRegionValue(regionName, indicator.id);
    if (!value || value.nfhs6 == null || value.india_nfhs6 == null) {
      return null;
    }
    const rawDiffFromIndia = value.nfhs6 - value.india_nfhs6;
    return getPolarity(indicator) === "positive" ? rawDiffFromIndia : -rawDiffFromIndia;
  }

  function getImprovementScore(regionName, indicator) {
    const value = getRegionValue(regionName, indicator.id);
    if (!value || value.nfhs6 == null || value.nfhs5 == null) {
      return null;
    }
    const equality = compareAtPrintedPrecision(value.nfhs6, value.nfhs5, indicator.precision);
    if (equality === "equal") {
      return 0;
    }
    const rawChange = value.nfhs6 - value.nfhs5;
    return getPolarity(indicator) === "positive" ? rawChange : -rawChange;
  }

  function getStatsSpread(values) {
    if (!values.length) {
      return 1;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const standardDeviation = Math.sqrt(variance);
    if (standardDeviation > 0) {
      return standardDeviation;
    }
    const maxAbsolute = Math.max(...values.map((value) => Math.abs(value)));
    return maxAbsolute || 1;
  }

  function rankEntries(entries, scoreKey) {
    const sortedDesc = [...entries].sort((a, b) => b[scoreKey] - a[scoreKey] || a.regionName.localeCompare(b.regionName));
    const sortedAsc = [...entries].sort((a, b) => a[scoreKey] - b[scoreKey] || a.regionName.localeCompare(b.regionName));
    const rankMap = new Map();
    const percentileMap = new Map();

    let lastScore = null;
    let currentRank = 0;
    sortedDesc.forEach((entry, index) => {
      if (lastScore === null || entry[scoreKey] !== lastScore) {
        currentRank = index + 1;
        lastScore = entry[scoreKey];
      }
      rankMap.set(entry.regionName, currentRank);
    });

    const groups = new Map();
    sortedAsc.forEach((entry) => {
      const key = String(entry[scoreKey]);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(entry);
    });

    let position = 0;
    groups.forEach((group) => {
      const start = position;
      const end = position + group.length - 1;
      const avgPos = (start + end) / 2;
      const percentile = sortedAsc.length <= 1 ? 100 : (avgPos / (sortedAsc.length - 1)) * 100;
      group.forEach((entry) => percentileMap.set(entry.regionName, percentile));
      position += group.length;
    });

    return { sortedDesc, rankMap, percentileMap };
  }

  function modeABucketForZ(z) {
    if (z == null) {
      return MODE_A_BUCKETS.find((bucket) => bucket.id === "missing");
    }
    if (z <= -2) return MODE_A_BUCKETS[0];
    if (z <= -1) return MODE_A_BUCKETS[1];
    if (z < -0.25) return MODE_A_BUCKETS[2];
    if (z <= 0.25) return MODE_A_BUCKETS[3];
    if (z < 1) return MODE_A_BUCKETS[4];
    if (z < 2) return MODE_A_BUCKETS[5];
    return MODE_A_BUCKETS[6];
  }

  function modeBBucketForEntry(entry) {
    if (!entry) {
      return MODE_B_BUCKETS.find((bucket) => bucket.id === "missing");
    }
    if (entry.equalAfterRounding) {
      return MODE_B_BUCKETS.find((bucket) => bucket.id === "no-change");
    }
    if (entry.improvementScore > 0 && entry.changeZ >= 1) {
      return MODE_B_BUCKETS.find((bucket) => bucket.id === "highest-improvement");
    }
    if (entry.improvementScore > 0) {
      return MODE_B_BUCKETS.find((bucket) => bucket.id === "improvement");
    }
    if (entry.improvementScore < 0 && entry.changeZ <= -1) {
      return MODE_B_BUCKETS.find((bucket) => bucket.id === "extremely-worsened");
    }
    return MODE_B_BUCKETS.find((bucket) => bucket.id === "worsened");
  }

  function getModeAPercentiles(indicator) {
    const entries = state.geojson.features.map((feature) => {
      const regionName = feature.properties.name;
      const values = getRegionValue(regionName, indicator.id);
      const goodnessDiffFromIndia = getGoodnessDiffFromIndia(regionName, indicator);
      return { regionName, values, goodnessDiffFromIndia };
    });

    const valid = entries.filter((entry) => entry.goodnessDiffFromIndia != null);
    const spread = getStatsSpread(valid.map((entry) => entry.goodnessDiffFromIndia));
    const rankings = rankEntries(valid, "goodnessDiffFromIndia");
    const byRegion = new Map();

    entries.forEach((entry) => {
      if (entry.goodnessDiffFromIndia == null) {
        byRegion.set(entry.regionName, {
          ...entry,
          zFromIndia: null,
          percentile: null,
          rank: null,
          bucket: MODE_A_BUCKETS.find((bucket) => bucket.id === "missing"),
          status: "Data unavailable",
        });
        return;
      }
      const zFromIndia = entry.goodnessDiffFromIndia / spread;
      const bucket = modeABucketForZ(clamp(zFromIndia, -2.5, 2.5));
      const comparison = compareAtPrintedPrecision(entry.values.nfhs6, entry.values.india_nfhs6, indicator.precision);
      byRegion.set(entry.regionName, {
        ...entry,
        zFromIndia,
        percentile: rankings.percentileMap.get(entry.regionName),
        rank: rankings.rankMap.get(entry.regionName),
        bucket,
        status:
          comparison === "equal"
            ? "Same as India average"
            : entry.goodnessDiffFromIndia > 0
              ? "Better than India average"
              : "Worse than India average",
      });
    });

    return { byRegion, ordered: rankings.sortedDesc, bucketDefs: MODE_A_BUCKETS };
  }

  function getModeABucket(regionName, indicator) {
    return getModeAPercentiles(indicator).byRegion.get(regionName)?.bucket;
  }

  function getModeBPercentiles(indicator) {
    const entries = state.geojson.features.map((feature) => {
      const regionName = feature.properties.name;
      const values = getRegionValue(regionName, indicator.id);
      const improvementScore = getImprovementScore(regionName, indicator);
      const equalAfterRounding =
        values &&
        values.nfhs6 != null &&
        values.nfhs5 != null &&
        compareAtPrintedPrecision(values.nfhs6, values.nfhs5, indicator.precision) === "equal";
      return { regionName, values, improvementScore, equalAfterRounding };
    });

    const valid = entries.filter((entry) => entry.improvementScore != null);
    const spread = getStatsSpread(valid.map((entry) => entry.improvementScore));
    const rankings = rankEntries(valid, "improvementScore");
    const byRegion = new Map();

    entries.forEach((entry) => {
      if (entry.improvementScore == null) {
        byRegion.set(entry.regionName, {
          ...entry,
          changeZ: null,
          percentile: null,
          rank: null,
          bucket: MODE_B_BUCKETS.find((bucket) => bucket.id === "missing"),
          status: "Data unavailable",
        });
        return;
      }
      const changeZ = entry.improvementScore / spread;
      const enriched = {
        ...entry,
        changeZ,
        percentile: rankings.percentileMap.get(entry.regionName),
        rank: rankings.rankMap.get(entry.regionName),
      };
      byRegion.set(entry.regionName, {
        ...enriched,
        bucket: modeBBucketForEntry(enriched),
        status:
          entry.equalAfterRounding
            ? "No change since NFHS-5"
            : entry.improvementScore > 0
              ? "Improved since NFHS-5"
              : "Worsened since NFHS-5",
      });
    });

    return { byRegion, ordered: rankings.sortedDesc, bucketDefs: MODE_B_BUCKETS };
  }

  function getModeBBucket(regionName, indicator) {
    return getModeBPercentiles(indicator).byRegion.get(regionName)?.bucket;
  }

  function isBelowReplacementFertility(regionName, indicator) {
    if (!/total fertility rate|tfr/i.test(indicator.label)) {
      return false;
    }
    const value = getRegionValue(regionName, indicator.id);
    return Boolean(value && value.nfhs6 != null && value.nfhs6 < 2.1);
  }

  function getAnalytics() {
    const indicator = getIndicator();
    return state.mode === "india" ? getModeAPercentiles(indicator) : getModeBPercentiles(indicator);
  }

  function getEntry(regionName) {
    return getAnalytics().byRegion.get(regionName);
  }

  function updateLegend() {
    const indicator = getIndicator();
    const analytics = getAnalytics();
    ui.legendItems.innerHTML = "";
    ui.legendNote.textContent =
      state.mode === "india"
        ? "Darker colour means farther from the India NFHS-6 reference value after polarity adjustment."
        : "Darker or stronger colour means greater improvement or regression since NFHS-5 after polarity adjustment.";

    analytics.bucketDefs.forEach((bucket) => {
      const count = Array.from(analytics.byRegion.values()).filter((entry) => entry.bucket.id === bucket.id).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `legend-item${state.activeLegendSelection?.type === "bucket" && state.activeLegendSelection.id === bucket.id ? " active" : ""}`;
      button.innerHTML = `
        <span class="swatch ${bucket.missing ? "missing-style" : ""}" style="background:${bucket.color}"></span>
        <span class="legend-item-label">${bucket.label}</span>
        <span class="legend-item-count">${count}</span>
      `;
      button.addEventListener("click", () => handleLegendClick(bucket.id, "bucket"));
      ui.legendItems.appendChild(button);
    });

    if (/total fertility rate|tfr/i.test(indicator.label)) {
      const count = state.geojson.features.filter((feature) => isBelowReplacementFertility(feature.properties.name, indicator)).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `legend-item${state.activeLegendSelection?.type === "tfr" ? " active" : ""}`;
      button.innerHTML = `
        <span class="swatch tfr-style"></span>
        <span class="legend-item-label">${TFR_BUCKET.label}</span>
        <span class="legend-item-count">${count}</span>
      `;
      button.addEventListener("click", () => handleLegendClick(TFR_BUCKET.id, "tfr"));
      ui.legendItems.appendChild(button);
    }
  }

  function handleLegendClick(bucketId, type) {
    if (
      state.activeLegendSelection &&
      state.activeLegendSelection.id === bucketId &&
      state.activeLegendSelection.type === type
    ) {
      clearLegendSelection();
      return;
    }
    state.activeLegendSelection = { id: bucketId, type };
    render();
  }

  function clearLegendSelection() {
    state.activeLegendSelection = null;
    render();
  }

  function isSelectedByLegend(regionName) {
    if (!state.activeLegendSelection) {
      return true;
    }
    const indicator = getIndicator();
    if (state.activeLegendSelection.type === "tfr") {
      return isBelowReplacementFertility(regionName, indicator);
    }
    return getEntry(regionName).bucket.id === state.activeLegendSelection.id;
  }

  function updateSelectedStatesPanel() {
    if (!state.activeLegendSelection) {
      ui.selectedStates.className = "stack muted";
      ui.selectedStates.textContent = "Click a legend bucket to select matching states and UTs.";
      return;
    }
    const indicator = getIndicator();
    const names = state.geojson.features
      .map((feature) => feature.properties.name)
      .filter((name) => isSelectedByLegend(name))
      .sort((a, b) => a.localeCompare(b));

    const label =
      state.activeLegendSelection.type === "tfr"
        ? TFR_BUCKET.label
        : getAnalytics().bucketDefs.find((bucket) => bucket.id === state.activeLegendSelection.id).label;

    ui.selectedStates.className = "stack";
    ui.selectedStates.innerHTML = `
      <p><span class="label">Selected bucket</span><br><span class="value">${label}</span></p>
      <p><span class="label">Matching states and UTs</span><br><span class="value">${names.length}</span></p>
      <ul>${names.map((name) => `<li>${name}${isBelowReplacementFertility(name, indicator) ? " (below replacement level)" : ""}</li>`).join("")}</ul>
    `;
  }

  function updateIndicatorDetails() {
    const indicator = getIndicator();
    const analytics = getAnalytics();
    const valid = analytics.ordered;
    const best = valid[0];
    const worst = valid[valid.length - 1];
    ui.indicatorDetails.innerHTML = `
      <p><span class="label">Indicator</span><br><span class="value">${indicator.display_label}</span></p>
      <p><span class="label">Polarity</span><br><span class="value">${indicator.polarity}</span></p>
      <p><span class="label">India NFHS-6 value</span><br><span class="value">${formatValue(indicator.india_nfhs6, indicator.precision, indicator.unit)}</span></p>
      <p><span class="label">States and UTs with data</span><br><span class="value">${valid.length}</span></p>
      <p><span class="label">Best-performing state or UT</span><br><span class="value">${best ? best.regionName : "NA"}</span></p>
      <p><span class="label">Worst-performing state or UT</span><br><span class="value">${worst ? worst.regionName : "NA"}</span></p>
      <p><span class="label">Explanation</span><br><span class="value">${
        state.mode === "india"
          ? "Colours are centred on the India NFHS-6 value from the factsheet."
          : "Colours show improvement or regression since the same state or UT’s NFHS-5 value."
      }</span></p>
      ${
        /total fertility rate|tfr/i.test(indicator.label)
          ? `<p><span class="label">Fertility note</span><br><span class="value">Purple marking indicates TFR below replacement level, defined here as less than 2.1.</span></p>`
          : ""
      }
    `;
  }

  function renderHover(regionName) {
    const indicator = getIndicator();
    const entry = getEntry(regionName);
    const value = getRegionValue(regionName, indicator.id);

    if (!value || !entry || entry.bucket.id === "missing") {
      ui.hoverDetails.className = "stack";
      ui.hoverDetails.innerHTML = `
        <p><span class="label">State or UT</span><br><span class="value">${regionName}</span></p>
        <p><span class="label">Status</span><br><span class="value">Data unavailable</span></p>
      `;
      return;
    }

    if (state.mode === "india") {
      const rawDiff = value.nfhs6 - value.india_nfhs6;
      ui.hoverDetails.className = "stack";
      ui.hoverDetails.innerHTML = `
        <p><span class="label">State/UT name</span><br><span class="value">${regionName}</span></p>
        <p><span class="label">Exact indicator label</span><br><span class="value">${indicator.display_label}</span></p>
        <p><span class="label">Polarity</span><br><span class="value">${indicator.polarity}</span></p>
        <p><span class="label">NFHS-6 state/UT value</span><br><span class="value">${formatValue(value.nfhs6, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">India NFHS-6 value</span><br><span class="value">${formatValue(value.india_nfhs6, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">NFHS-5 state/UT value</span><br><span class="value">${formatValue(value.nfhs5, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">Difference from India average</span><br><span class="value">${formatDiff(rawDiff, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">Better/worse status</span><br><span class="value">${entry.status}</span></p>
        <p><span class="label">Percentile among states/UTs</span><br><span class="value">${formatNumber(entry.percentile, 0)}</span></p>
        <p><span class="label">Rank among states/UTs</span><br><span class="value">${entry.rank}</span></p>
        <p><span class="label">z-score from India average</span><br><span class="value">${formatNumber(entry.zFromIndia, 2)}</span></p>
        <p><span class="label">Colour bucket</span><br><span class="value">${entry.bucket.label}</span></p>
        ${
          /total fertility rate|tfr/i.test(indicator.label)
            ? `<p><span class="label">Replacement-level benchmark</span><br><span class="value">2.1</span></p>
               <p><span class="label">Status</span><br><span class="value">${isBelowReplacementFertility(regionName, indicator) ? "Below replacement level" : "At/above replacement level"}</span></p>`
            : ""
        }
      `;
    } else {
      const rawChange = value.nfhs6 - value.nfhs5;
      ui.hoverDetails.className = "stack";
      ui.hoverDetails.innerHTML = `
        <p><span class="label">State/UT name</span><br><span class="value">${regionName}</span></p>
        <p><span class="label">Exact indicator label</span><br><span class="value">${indicator.display_label}</span></p>
        <p><span class="label">Polarity</span><br><span class="value">${indicator.polarity}</span></p>
        <p><span class="label">NFHS-6 state/UT value</span><br><span class="value">${formatValue(value.nfhs6, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">NFHS-5 state/UT value</span><br><span class="value">${formatValue(value.nfhs5, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">Raw change from NFHS-5 to NFHS-6</span><br><span class="value">${formatDiff(rawChange, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">Improvement score</span><br><span class="value">${formatDiff(entry.improvementScore, indicator.precision, indicator.unit)}</span></p>
        <p><span class="label">Improved/worsened status</span><br><span class="value">${entry.status}</span></p>
        <p><span class="label">Improvement percentile</span><br><span class="value">${formatNumber(entry.percentile, 0)}</span></p>
        <p><span class="label">Rank by improvement</span><br><span class="value">${entry.rank}</span></p>
        <p><span class="label">changeZ</span><br><span class="value">${formatNumber(entry.changeZ, 2)}</span></p>
        <p><span class="label">Colour bucket</span><br><span class="value">${entry.bucket.label}</span></p>
        ${
          /total fertility rate|tfr/i.test(indicator.label)
            ? `<p><span class="label">Replacement-level benchmark</span><br><span class="value">2.1</span></p>
               <p><span class="label">Status</span><br><span class="value">${isBelowReplacementFertility(regionName, indicator) ? "Below replacement level" : "At/above replacement level"}</span></p>`
            : ""
        }
      `;
    }
  }

  function showTooltip(event, regionName) {
    const indicator = getIndicator();
    const entry = getEntry(regionName);
    const value = getRegionValue(regionName, indicator.id);

    if (!value || !entry || entry.bucket.id === "missing") {
      ui.tooltip.innerHTML = `<strong>${regionName}</strong><br>Data unavailable`;
    } else if (state.mode === "india") {
      ui.tooltip.innerHTML = `
        <strong>${regionName}</strong><br>
        ${indicator.display_label}<br>
        Percentile: ${formatNumber(entry.percentile, 0)}<br>
        Rank: ${entry.rank}<br>
        z-score: ${formatNumber(entry.zFromIndia, 2)}<br>
        Bucket: ${entry.bucket.label}
      `;
    } else {
      ui.tooltip.innerHTML = `
        <strong>${regionName}</strong><br>
        ${indicator.display_label}<br>
        Improvement percentile: ${formatNumber(entry.percentile, 0)}<br>
        Rank: ${entry.rank}<br>
        changeZ: ${formatNumber(entry.changeZ, 2)}<br>
        Bucket: ${entry.bucket.label}
      `;
    }
    ui.tooltip.classList.remove("hidden");
    ui.tooltip.style.left = `${event.offsetX + 16}px`;
    ui.tooltip.style.top = `${event.offsetY + 16}px`;
  }

  function createPatternDefs(svg) {
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <pattern id="missing-pattern" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
        <rect width="10" height="10" fill="#c7c2b8"></rect>
        <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(255,255,255,0.75)" stroke-width="3"></line>
      </pattern>
    `;
    svg.appendChild(defs);
  }

  function renderMap() {
    ui.svg.innerHTML = "";
    createPatternDefs(ui.svg);

    const width = 900;
    const height = 900;
    const projection = d3.geoMercator().fitSize([width, height], state.geojson);
    const path = d3.geoPath(projection);

    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("class", "map-bg");
    background.setAttribute("width", String(width));
    background.setAttribute("height", String(height));
    background.addEventListener("click", clearLegendSelection);
    ui.svg.appendChild(background);

    state.geojson.features.forEach((feature) => {
      const regionName = feature.properties.name;
      const entry = getEntry(regionName);
      const region = document.createElementNS("http://www.w3.org/2000/svg", "path");
      region.setAttribute("d", path(feature));
      let className = "region";
      if (state.activeLegendSelection && !isSelectedByLegend(regionName)) {
        className += " dimmed";
      }
      if (state.activeLegendSelection && isSelectedByLegend(regionName)) {
        className += " selected";
      }
      region.setAttribute("class", className);
      region.setAttribute("fill", entry.bucket.id === "missing" ? "url(#missing-pattern)" : entry.bucket.color);
      region.addEventListener("mousemove", (event) => {
        region.classList.add("hovered");
        renderHover(regionName);
        showTooltip(event, regionName);
      });
      region.addEventListener("mouseleave", () => {
        region.classList.remove("hovered");
        ui.tooltip.classList.add("hidden");
      });
      region.addEventListener("click", (event) => event.stopPropagation());
      ui.svg.appendChild(region);
    });

    const indicator = getIndicator();
    if (/total fertility rate|tfr/i.test(indicator.label)) {
      state.geojson.features.forEach((feature) => {
        const regionName = feature.properties.name;
        if (!isBelowReplacementFertility(regionName, indicator)) {
          return;
        }
        const overlay = document.createElementNS("http://www.w3.org/2000/svg", "path");
        overlay.setAttribute("d", path(feature));
        overlay.setAttribute(
          "class",
          `fertility-overlay${state.activeLegendSelection && !isSelectedByLegend(regionName) ? " dimmed" : ""}`,
        );
        ui.svg.appendChild(overlay);
      });
    }
  }

  function renderControls() {
    ui.indicatorSelect.innerHTML = "";
    state.dataset.indicators.forEach((indicator) => {
      const option = document.createElement("option");
      option.value = indicator.id;
      option.textContent = indicator.display_label;
      ui.indicatorSelect.appendChild(option);
    });
    ui.indicatorSelect.value = state.selectedIndicatorId;
  }

  function render() {
    updateLegend();
    updateIndicatorDetails();
    updateSelectedStatesPanel();
    renderMap();
  }

  async function init() {
    clearError();
    if (!window.d3) {
      throw new Error("The D3 library did not load.");
    }

    const [dataset, geojson] = await Promise.all([
      fetchJson("./data/nfhs_state_indicators.json", "Indicator dataset"),
      fetchJson("./data/india_states_ut.geojson", "GeoJSON boundary file"),
    ]);

    validateDataset(dataset);
    validateGeojson(geojson);

    state.dataset = dataset;
    state.geojson = geojson;
    state.indicatorsById = new Map(dataset.indicators.map((indicator) => [indicator.id, indicator]));
    state.regionsByGeoName = new Map(dataset.regions.map((region) => [region.geojson_name, region]));
    state.selectedIndicatorId = dataset.indicators[0].id;

    renderControls();
    render();

    ui.indicatorSelect.addEventListener("change", (event) => {
      state.selectedIndicatorId = event.target.value;
      state.activeLegendSelection = null;
      render();
    });

    ui.modeInputs.forEach((input) => {
      input.addEventListener("change", (event) => {
        state.mode = event.target.value;
        state.activeLegendSelection = null;
        render();
      });
    });

    ui.clearSelection.addEventListener("click", clearLegendSelection);
  }

  init().catch((error) => {
    console.error(error);
    showError(`Failed to load the app data. ${error.message}`);
  });
})();
