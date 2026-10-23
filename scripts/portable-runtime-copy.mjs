// Packing and the installed Electron bootstrap share one copy/validation contract.
import runtimeCopy from '../apps/desktop/electron/runtime-copy.cjs';

export const { copyRuntimeTree, verifyPortableRuntimeTree } = runtimeCopy;
