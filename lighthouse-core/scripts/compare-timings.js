/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

// Example:
//     node lighthouse-core/scripts/compare-timings.js --name my-collection --collect -n 3 --lh-flags='--only-audits=unminified-javascript' --urls https://www.example.com https://www.nyt.com
//     node lighthouse-core/scripts/compare-timings.js --name my-collection --summarize --measure-filter 'loadPage|connect'
//     node lighthouse-core/scripts/compare-timings.js --name base --name pr --compare

const fs = require('fs');
const mkdirp = require('mkdirp');
const glob = require('glob');
const {execSync} = require('child_process');
const yargs = require('yargs');

const LH_ROOT = `${__dirname}/../..`;
const ROOT_OUTPUT_DIR = `${LH_ROOT}/timings-data`;

const argv = yargs
  .help('help')
  .describe({
    // common flags
    'name': 'Unique identifier, makes the folder for storing LHRs. Not a path',
    'report-exclude': 'Regex of properties to exclude. Set to "none" to disable default',
    // collection
    'gather': 'Just gathers',
    'audit': 'Audits from the artifacts on disk',
    'collect': 'Gathers, audits and saves LHRs to disk',
    'lh-flags': 'Lighthouse flags',
    'urls': 'Urls to run',
    'n': 'Number of times to run',
    // --summarize
    'summarize': 'Prints statistics report',
    'measure-filter': 'Regex of measures to include. Optional',
    'output': 'table, json',
    // --compare
    'compare': 'Compare two sets of LHRs',
    'delta-property-sort': 'Property to sort by its delta',
    'desc': 'Set to override default ascending sort',
  })
  .string('measure-filter')
  .default('report-exclude', 'min|max|stdev|^n$')
  .default('delta-property-sort', 'mean')
  .default('output', 'table')
  .array('urls')
  .string('lh-flags')
  .default('desc', false)
  .default('lh-flags', '')
  .strict() // fail on unknown commands
  .wrap(yargs.terminalWidth())
.argv;

const reportExcludeRegex =
  argv.reportExclude !== 'none' ? new RegExp(argv.reportExclude, 'i') : null;

/**
 * @param {string} name
 */
function dir(name) {
  return `${ROOT_OUTPUT_DIR}/${name}`;
}

/**
 * @param {number[]} values
 */
function sum(values) {
  return values.reduce((sum, value) => sum + value);
}

/**
 * @param {number[]} values
 */
function average(values) {
  return sum(values) / values.length;
}

/**
 * @param {number[]} values
 */
function sampleStdev(values) {
  const mean = average(values);
  const variance = sum(values.map(value => (value - mean) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * @param {string} url
 * @return string
 */
function urlToFolder(url) {
  return url.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Round to the tenth.
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 10) / 10;
}

function gather() {
  const outputDir = dir(argv.name);
  mkdirp.sync(ROOT_OUTPUT_DIR);
  // Don't overwrite a previous collection
  if (fs.existsSync(outputDir)) throw new Error(`folder already exists: ${outputDir}`);
  fs.mkdirSync(outputDir);

  for (const url of argv.urls) {
    for (let i = 0; i < argv.n; i++) {
      const gatherDir = `${outputDir}/${urlToFolder(url)}/${i}/`;
      mkdirp.sync(gatherDir);
      // TODO include multiple urls too.
      const progressBar = new Array(Math.round(i * 40/ argv.n)).fill('▄').join('').padEnd(40);
      console.log(`Gathering:   `, '|', progressBar, '|')
      const cmd = [
        'node',
        `${LH_ROOT}/lighthouse-cli`,
        url,
        `--gather-mode=${gatherDir}`,
        argv.lhFlags,
      ].join(' ');
      execSync(cmd, {stdio: 'ignore'});
    }
  }
}

function audit() {
  const outputDir = dir(argv.name);
  for (const url of argv.urls) {
    for (let i = 0; i < argv.n; i++) {
      const gatherDir = `${outputDir}/${urlToFolder(url)}/${i}/`;
      const progressBar = new Array(Math.round(i * 40/ argv.n)).fill('▄').join('').padEnd(40);
      console.log(`Auditing:   `, '|', progressBar, '|')

      const cmd = [
        'node',
        `${LH_ROOT}/lighthouse-cli`,
        url,
        `--audit-mode=${gatherDir}`,
        `--output-path=${outputDir}/lhr-${urlToFolder(url)}-${i}.json`,
        '--output=json',
        argv.lhFlags,
      ].join(' ');
      execSync(cmd, {stdio: 'ignore'});
    }
  }
}

/**
 * @param {string} name
 * @param {string} resultType
 */
function aggregateResults(name, resultType = 'timings') {
  const outputDir = dir(name);

  // `${url}@@@${entry.name}` -> duration
  /** @type {Map<string, number[]>} */
  const durationsMap = new Map();
  const measureFilter = argv.measureFilter ? new RegExp(argv.measureFilter, 'i') : null;

  for (const lhrPath of glob.sync(`${outputDir}/*.json`)) {
    const lhrJson = fs.readFileSync(lhrPath, 'utf-8');
    /** @type {LH.Result} */
    const lhr = JSON.parse(lhrJson);

    // Group the durations of each entry of the same name.
    /** @type {Record<string, number[]>} */
    const durationsByName = {};

    const metrics = /** @type {!LH.Audit.Details.Table} */ (lhr.audits.metrics.details).items[0];
    const entries = resultType === 'metrics' ?
        Object.entries(metrics) :
        lhr.timing.entries.map(entry => ([entry.name, entry.duration]));

    for (const [name, timimg] of entries) {
      if (measureFilter && !measureFilter.test(name)) {
        continue;
      }

      const durations = durationsByName[name] = durationsByName[name] || [];
      durations.push(timimg);
    }

    // Push the aggregate time of each unique (by name) entry.
    for (const [name, durationsForSingleRun] of Object.entries(durationsByName)) {
      const key = `${lhr.requestedUrl}@@@${name}`;
      let durations = durationsMap.get(key);
      if (!durations) {
        durations = [];
        durationsMap.set(key, durations);
      }
      durations.push(sum(durationsForSingleRun));
    }
  }

  return [...durationsMap].map(([key, durations]) => {
    const [url, entryName] = key.split('@@@');
    const mean = average(durations);
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const stdev = sampleStdev(durations);
    return {
      key,
      metric: entryName,
      url,
      n: durations.length,
      mean: round(mean),
      stdev: round(stdev),
      cv: (stdev / mean).toFixed(3),
      min: round(min),
      max: round(max),
    };
  }).sort((a, b) => {
    // sort by {measure, url}
    const measureComp = a.metric.localeCompare(b.metric);
    if (measureComp !== 0) return measureComp;
    return a.url.localeCompare(b.url);
  });
}

/**
 * @param {*[]} results
 */
function filter(results) {
  if (!reportExcludeRegex) return;

  for (const result of results) {
    for (const key in result) {
      // if (reportExcludeRegex.test(key)) delete result[key];
    }
  }
}

/**
 * @param {number=} value
 * @return {value is number}
 */
function exists(value) {
  return typeof value !== 'undefined';
}

function summarize() {
  for (const resultType of ['timings', 'metrics']) { 
    const results = aggregateResults(argv.name, resultType);
    filter(results);
    print(results);
  }
}

/**
 * @param {number=} base
 * @param {number=} other
 */
function compareValues(base, other) {
  const basePart = exists(base) ? base : 'N/A';
  const otherPart = exists(other) ? other : 'N/A';
  return {
    description: `${basePart} -> ${otherPart}`,
    delta: exists(base) && exists(other) ? (other - base) : undefined,
  };
}

function compare() {
  if (!Array.isArray(argv.name) || argv.name.length !== 2) {
    throw new Error('expected two entries for name option');
  }

  const baseResults = aggregateResults(argv.name[0]);
  const otherResults = aggregateResults(argv.name[1]);

  const keys = [...new Set([...baseResults.map(r => r.key), ...otherResults.map(r => r.key)])];
  const results = keys.map(key => {
    const baseResult = baseResults.find(result => result.key === key);
    const otherResult = otherResults.find(result => result.key === key);

    const someResult = baseResult || otherResult;
    if (!someResult) throw new Error('impossible');

    const mean = compareValues(baseResult && baseResult.mean, otherResult && otherResult.mean);
    const stdev = compareValues(baseResult && baseResult.stdev, otherResult && otherResult.stdev);
    const cv = compareValues(baseResult && baseResult.cv, otherResult && otherResult.cv);
    const min = compareValues(baseResult && baseResult.min, otherResult && otherResult.min);
    const max = compareValues(baseResult && baseResult.max, otherResult && otherResult.max);

    return {
      'measure': someResult.metric,
      'url': someResult.url,
      'mean': mean.description,
      'mean Δ': exists(mean.delta) ? round(mean.delta) : undefined,
      'stdev': stdev.description,
      'stdev Δ': exists(stdev.delta) ? round(stdev.delta) : undefined,
      'cv': cv.description,
      'cv Δ': exists(cv.delta) ? round(cv.delta) : undefined,
      'min': min.description,
      'min Δ': exists(min.delta) ? round(min.delta) : undefined,
      'max': max.description,
      'max Δ': exists(max.delta) ? round(max.delta) : undefined,
    };
  });

  const sortByKey = `${argv.deltaPropertySort} Δ`;
  results.sort((a, b) => {
    // @ts-ignore - shhh tsc.
    const aValue = a[sortByKey];
    // @ts-ignore - shhh tsc.
    const bValue = b[sortByKey];

    // Always put the keys missing a result at the bottom of the table.
    if (!exists(aValue)) return 1;
    else if (!exists(bValue)) return -1;

    return (argv.desc ? 1 : -1) * (Math.abs(aValue) - Math.abs(bValue));
  });
  filter(results);
  print(results);
}

/**
 * @param {*[]} results
 */
function print(results) {
  if (argv.output === 'table') {
    // eslint-disable-next-line no-console
    console.table(results);
  } else if (argv.output === 'json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(results, null, 2));
  }
}

function main() {
  if (argv.gather) gather();
  if (argv.audit) audit();
  if (argv.collect) {
    gather();
    audit();
  }
  if (argv.summarize) summarize();
  if (argv.compare) compare();
}

main();
