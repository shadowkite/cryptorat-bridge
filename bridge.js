import { TestNetWallet, Wallet, TokenMintRequest } from "mainnet-js";
import {bigIntToVmNumber, binToHex, decodeCashAddress} from '@bitauth/libauth';
import { ethers } from "ethers";
import {
  writeInfoToDb,
  getAllBridgeInfo,
  getRecentBridgeInfo,
  checkAmountBridgedDb,
  addBridgeInfoToNFT,
  bridgeInfoEthAddress,
  initiateTable,
  getCtAddress
} from "./database.js"
import abi from "./abi.json" assert { type: 'json' }
import express from "express";
import cors from "cors";
import 'dotenv/config'
import * as fs from "fs";
import axios from "axios";
import * as https from "https";

const tokenId = process.env.TOKENID;
const network =  process.env.NETWORK;
const derivationPathAddress = process.env.DERIVATIONPATH;
const seedphrase = process.env.SEEDPHRASE;
const serverUrl = process.env.SERVER_URL;
const contractAddress = process.env.CONTRACTADDR;
let nftsBridged = 0;

/** Initiate wallet **/
const walletClass = (network === "mainnet" ? Wallet : TestNetWallet);
const wallet = await walletClass.fromSeed(seedphrase, derivationPathAddress);
console.log(`wallet address: ${wallet.getDepositAddress()}`);
const balance = await wallet.getBalance();
console.log(`Bch amount in walletAddress is ${balance.bch} BCH or ${balance.sat} SATS`);

/** Express HTTPS **/
const expressPrivateKey = process.env.PRIVKEY_PATH ? fs.readFileSync(process.env.PRIVKEY_PATH) : null;
const expressCertificate = process.env.CERT_PATH ? fs.readFileSync(process.env.CERT_PATH) : null;

/** SmartBCH provider & contract **/
const provider = new ethers.providers.JsonRpcProvider('https://smartbch.greyh.at');
const ratContract = new ethers.Contract(contractAddress, abi, provider);

/** Stores whether the bridge is busy **/
let bridgingNft = false;

/** Burn addresses **/
const deadAddress = "0x000000000000000000000000000000000000dEaD"
const burnAddress = "0x0000000000000000000000000000000000000000"

/** Initiate SQL table **/
initiateTable().then(() => {
  console.log('Initiated table')
})

/** Block event replay **/
const replayEvents = async function () {
  try {
    let eventFilter = ratContract.filters.Transfer();
    let currentBlock = await provider.getBlockNumber();
    for (let j = 0; j < 10; j++) {
      let events = await ratContract.queryFilter(eventFilter, (currentBlock - (j * 1000) - 1000), (currentBlock - (j * 1000)));
      for (let i in events) {
        addEventToDb(events[i]).then((result) => {
          if (!result) console.log('Skipped')
        })
      }
    }
  } catch (e) {
    console.log(e);
  }
}

/** Utility function **/
const validateMainchainSignature = async function (origin, message, signature) {
  let slpPublicAddress = await Wallet.watchOnly(origin)
  if(await slpPublicAddress.verify(message, signature)) {
    return true;
  }
  return false;
}

const addEventToDb = async function (event) {
  const erc721numberHex = event.args[2]?._hex
  const nftNumber = parseInt(erc721numberHex, 16);
  if(event.args.to !== burnAddress && event.args.to !== deadAddress)
    return
  if(nftNumber > 10025) // Skip traits - Rat specific
    return
  console.log(`${ event.args.from } burnt rat #${nftNumber}`);
  const timeBurned = new Date().toISOString();
  const burnInfo = {
    timeBurned,
    txIdSmartBCH: event?.transactionHash,
    nftNumber,
    sbchOriginAddress: event.args.from.toLowerCase()
  }
  await writeInfoToDb(burnInfo);
}

const cacheMetadata = async function() {
  for (let i = 1; i <= 10025; i++) {
    if(!fs.existsSync('./storage/' + tokenId + '.json')) {
      try {
        await saveMetadata(i);
      } catch(e) {
        // Token does not exist apparently
      }
    }
  }
}

const isTokenAddress = function(address) {
  const result = decodeCashAddress(address);
  if (typeof result === 'string') throw new Error(result);
  return (result.type === 'p2pkhWithTokens' || result.type === 'p2shWithTokens');
}

const saveMetadata = async function (tokenId) {
  console.log('Caching ' + tokenId);
  const metadata = await ratContract.tokenURI(tokenId);
  fs.writeFileSync('./storage/' + tokenId + '.json', JSON.stringify({url: metadata}));
}

/** Bridge functions **/

async function tryBridging(bchOriginAddress, destinationAddress, signatureProof) {
  console.log('Trying..')
  // if bridging is already happening, wait 2 seconds
  if(bridgingNft) {
    await new Promise(r => setTimeout(r, 2000));
    return await tryBridging(bchOriginAddress, destinationAddress, signatureProof);
  } else {
    try {
      bridgingNft = true;
      if(!isTokenAddress(destinationAddress)) {
        throw `Not a valid CT address`
      }

      const infoAddress = await bridgeInfoEthAddress(bchOriginAddress);
      const listNftItems = infoAddress.filter(item => !item.timeBridged)
      if(!listNftItems.length) throw("empty list!")
      const txid = await bridgeNFTs(listNftItems, destinationAddress, signatureProof);
      bridgingNft = false;
      return txid
    } catch (error) {
      console.log(error);
      bridgingNft = false;
      return
    }
  }
}

async function bridgeNFTs(listNftNumbers, destinationAddress, signatureProof){
  try{
    // create bridging transaction
    const mintRequests = [];
    listNftNumbers.forEach(nft => {
      console.log(nft)
      // vm numbers start counting from zero
      const vmNumber = bigIntToVmNumber(BigInt(nft.nftNumber) - 1n);
      const nftCommitment = binToHex(vmNumber);
      const mintNftOutput = new TokenMintRequest({
        cashaddr: destinationAddress,
        commitment: nftCommitment,
        capability: "none",
        value: 1000,
      })
      mintRequests.push(mintNftOutput);
    })
    const { txId } = await wallet.tokenMint( tokenId, mintRequests );
    nftsBridged += listNftNumbers.length;
    // create db entries
    const timeBridged = new Date().toISOString();

    listNftNumbers.forEach(nft => {
      const bridgeInfo = {
        timeBridged,
        signatureProof,
        txIdBCH: txId,
        destinationAddress
      }
      addBridgeInfoToNFT(nft.nftNumber, bridgeInfo);
      fs.writeFileSync('./storage/ct_' + nft.nftNumber + '.json', "");
    })
    return txId
  } catch (error) {
    console.log(error)
  }
}

/** Setup **/
const main = async function() {
  const amountBridgedDb = await checkAmountBridgedDb();
  if (amountBridgedDb) {
    console.log(`Read amountBridgedDb on restart, setting nftsBridged to ${amountBridgedDb}`);
    nftsBridged = amountBridgedDb;
  }

  /** Express setup **/
  const app = express();
  const url = process.env.NODE_ENV === "development" ? "http://localhost:3000" : serverUrl;

  app.use(cors());
  app.use(express.json()); //req.body

  /** Endpoints **/
  app.get('/', (req, res) => {
    res.json({nftsBridged});
  })

  /** SLP Bridge **/
  app.post('/slp-bridge', async (req, res) => {
    const {slpOrigin, dstAddress, message, signature} = req.body;
    if (!await validateMainchainSignature()) {
      throw `Invalid signature`
    }
    await tryBridging(slpOrigin, dstAddress, message + '-' + signature)
  })

  app.post('/slp-sign', async (req, res) => {
    try {
      const {slpOrigin, message, signature} = req.body;
      let origin = slpOrigin

      if (slpOrigin.length < 30 || message.length < 10 || signature.length < 20) {
        throw `Somethings wrong`
      }

      if (!await validateMainchainSignature(slpOrigin, message, signature)) {
        throw `Invalid signature`
      }

      let balances = await axios.get(`https://rest.bch.actorforth.org/v2/slp/balancesForAddress/` + origin)
      for (let i in balances.data) {
        try {
          let token = await axios.get(`https://api.cryptor.at/original/nft/` + balances.data[i].tokenId)
          if (typeof token.data['rat-number'] == 'undefined') {
            console.log(balances.data[i].tokenId)
            continue;
          }
          const timeBurned = new Date().toISOString();
          const burnInfo = {
            timeBurned,
            txIdSmartBCH: balances.data[i].tokenId,
            nftNumber: token.data['rat-number'],
            sbchOriginAddress: origin
          }
          await writeInfoToDb(burnInfo);
        } catch (e) {
          console.log(e)
          console.log('skipped')
        }
      }
      const infoAddress = await bridgeInfoEthAddress(slpOrigin);
      const listNftItems = infoAddress.filter(item => !item.timeBridged)
      if (listNftItems) {
        res.json(listNftItems);
      } else {
        res.status(404).send();
      }
    } catch (e) {
      console.log(e)
    }
  });

  /** SmartBCH Bridge **/
  app.post("/signbridging", async (req, res) => {
    try {
      const {sbchOriginAddress, destinationAddress, signature} = req.body;
      const signingAddress = ethers.utils.verifyMessage(destinationAddress, signature);
      if (signingAddress.toLowerCase() !== sbchOriginAddress.toLowerCase()) {
        res.json({error: 'Invalid signature'})
        return
      }
      const txid = await tryBridging(sbchOriginAddress, destinationAddress, signature);
      if (txid) res.json({txid});
      else res.status(404).send();
    } catch (error) {
      res.json({error: error})
    }
  });

  app.get("/address/:originAddress", async (req, res) => {
    const infoAddress = await bridgeInfoEthAddress(req.params.originAddress);
    const listNftItems = infoAddress.filter(item => !item.timeBridged)
    if (listNftItems) {
      res.json(listNftItems);
    } else {
      res.status(404).send();
    }
  });

  /** Utilities **/
  app.get('/ct-address/:originAddress', async (req, res) => {
    try {
      res.json({'address': await getCtAddress(req.params.originAddress)});
    } catch (error) {
      res.json({'address': null})
    }
  })

  app.get("/all", async (req, res) => {
    const infoAllBridged = await getAllBridgeInfo();
    if (infoAllBridged) {
      res.json(infoAllBridged);
    } else {
      res.status(404).send();
    }
  });

  app.get("/recent", async (req, res) => {
    const infoRecentBridged = await getRecentBridgeInfo();
    if (infoRecentBridged) {
      res.json(infoRecentBridged);
    } else {
      res.status(404).send();
    }
  });

  /** Start SBCH event listeners **/
  ratContract.on("Transfer", async (from, to, amount, event) => {
    await addEventToDb(event)
  });

  ratContract.on('PowerUpdated', async (owner, tokenId, power) => {
    await saveMetadata(tokenId)
  });

  /** Replay blocks before startup **/
  await replayEvents()

  https.createServer({
    key: expressPrivateKey,
    cert: expressCertificate
  }, app).listen(3050, () => {
    console.log(`Server started`);

    // cacheMetadata();
  });
}

/** Start server **/
main()