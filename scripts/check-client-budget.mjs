#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const distRoot = path.resolve('dist');
const indexPath = path.join(distRoot, 'index.html');
// Includes about 27 KB of React Compiler memoization code.
const maximumInitialJavaScriptBytes = 505 * 1_024;
const maximumInitialBrotliBytes = 151 * 1_024;

const indexHtml = await fs.readFile(indexPath, 'utf8');
const entryMatch = indexHtml.match(/<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*><\/script>/i);

if (!entryMatch) {
  throw new Error(`Cannot find the client entry script in ${indexPath}`);
}

const modulePreloadPaths = [
  ...indexHtml.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*\bhref=["']([^"']+\.js)["'][^>]*>/gi),
].map((preloadMatch) => preloadMatch[1]);
const initialAssetPaths = [...new Set([entryMatch[1], ...modulePreloadPaths])];

function resolveDistAsset(assetPath) {
  const relativeAssetPath = assetPath.replace(/^\//, '');
  const resolvedAssetPath = path.resolve(distRoot, relativeAssetPath);
  const relativePathFromDist = path.relative(distRoot, resolvedAssetPath);

  if (relativePathFromDist.startsWith('..') || path.isAbsolute(relativePathFromDist)) {
    throw new Error(`Initial asset resolves outside ${distRoot}: ${assetPath}`);
  }

  return resolvedAssetPath;
}

async function fileSize(filePath) {
  return (await fs.stat(filePath)).size;
}

const initialJavaScriptBytes = (
  await Promise.all(initialAssetPaths.map((assetPath) => fileSize(resolveDistAsset(assetPath))))
).reduce((totalBytes, assetBytes) => totalBytes + assetBytes, 0);
const initialBrotliBytes = (
  await Promise.all(
    initialAssetPaths.map(async (assetPath) => {
      const assetFilePath = resolveDistAsset(assetPath);
      try {
        return await fileSize(`${assetFilePath}.br`);
      } catch (error) {
        if (error?.code === 'ENOENT') return fileSize(assetFilePath);
        throw error;
      }
    })
  )
).reduce((totalBytes, assetBytes) => totalBytes + assetBytes, 0);

const exceededBudgets = [
  ['initial JavaScript', initialJavaScriptBytes, maximumInitialJavaScriptBytes],
  ['initial Brotli transfer', initialBrotliBytes, maximumInitialBrotliBytes],
].filter(([, measuredBytes, maximumBytes]) => measuredBytes > maximumBytes);

if (exceededBudgets.length > 0) {
  const budgetFailures = exceededBudgets
    .map(([budgetName, measuredBytes, maximumBytes]) => `${budgetName}: ${measuredBytes} > ${maximumBytes} bytes`)
    .join('\n');
  throw new Error(`Client performance budget exceeded:\n${budgetFailures}`);
}

console.log(
  `Client budget passed: ${initialJavaScriptBytes} initial bytes, ` +
    `${initialBrotliBytes} Brotli bytes across ${initialAssetPaths.length} assets.`
);
