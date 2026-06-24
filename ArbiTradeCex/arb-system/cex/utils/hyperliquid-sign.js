/**
 * Hyperliquid L1 action signing (wallet private key).
 * Requires @msgpack/msgpack for action hashing.
 */
import { ethers } from 'ethers';

let msgpackEncode = null;

async function getMsgpackEncode() {
  if (msgpackEncode) return msgpackEncode;
  try {
    const mod = await import('@msgpack/msgpack');
    msgpackEncode = mod.encode;
    return msgpackEncode;
  } catch {
    throw new Error('Hyperliquid signing requires @msgpack/msgpack (npm install @msgpack/msgpack)');
  }
}

function hexToBytes(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function addressToBytes(address) {
  return hexToBytes(ethers.getAddress(address));
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function nonceToBytes(nonce) {
  const buf = new Uint8Array(8);
  let n = BigInt(nonce);
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

async function actionHash(action, vaultAddress, nonce, expiresAfter) {
  const encode = await getMsgpackEncode();
  const parts = [encode(action)];
  parts.push(nonceToBytes(nonce));
  if (vaultAddress) {
    parts.push(new Uint8Array([1]));
    parts.push(addressToBytes(vaultAddress));
  } else {
    parts.push(new Uint8Array([0]));
  }
  if (expiresAfter != null) {
    parts.push(new Uint8Array([0]));
  }
  return ethers.keccak256(concatBytes(...parts));
}

async function signUserSignedAction(wallet, action, isMainnet = true) {
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: isMainnet ? 1337 : 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000'
  };
  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' }
    ]
  };
  const message = {
    source: isMainnet ? 'a' : 'b',
    connectionId: action
  };
  return wallet.signTypedData(domain, types, message);
}

export async function signL1Action(privateKey, action, { nonce, vaultAddress = null, expiresAfter = null, isMainnet = true } = {}) {
  const wallet = new ethers.Wallet(String(privateKey).trim());
  const hash = await actionHash(action, vaultAddress, nonce, expiresAfter);
  const signature = await signUserSignedAction(wallet, hash, isMainnet);
  return { wallet, signature, nonce };
}

export function splitHyperliquidSignature(signature) {
  const sig = ethers.Signature.from(signature);
  return {
    r: sig.r,
    s: sig.s,
    v: sig.v
  };
}

export default { signL1Action, splitHyperliquidSignature };
