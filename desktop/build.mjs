if (process.platform === 'darwin') {
  await import('./build-macos.mjs');
} else {
  await import('./build-portable.mjs');
}
