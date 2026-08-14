const { resolve } = require('node:path')

const base = require(resolve(process.cwd(), 'config/electron-builder.config.cjs'))

module.exports = {
  ...base,
  publish: null,
  generateUpdatesFilesForAllChannels: false,
  forceCodeSigning: false,
  nsis: {
    ...base.nsis,
    differentialPackage: false
  },
  mac: {
    ...base.mac,
    hardenedRuntime: false,
    notarize: false,
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      }
    ]
  }
}
