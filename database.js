import sqlite3 from 'sqlite3'
import * as dotenv from "dotenv";
dotenv.config();

const db = new sqlite3.Database('bridge.sqlite');

function getRows(query) {
  return new Promise(function (resolve, reject) {
    let response;
    db.all(query, function cb(err, rows) {
      if (err) {
        response = {
          'query': query,
          'error': err
        };
        reject(response);
      } else {
        response = {
          rows: rows
        };
        resolve(response);
      }
    });
  });
}

export async function initiateTable() {
  db.run("CREATE TABLE IF NOT EXISTS bridge(\n" +
      "  id integer PRIMARY KEY,\n" +
      "  timeBurned varchar(40),\n" +
      "  txIdSmartBCH varchar(80),\n" +
      "  sbchOriginAddress varchar(80),\n" +
      "  nftNumber integer,\n" +
      "  timeBridged varchar(40),\n" +
      "  txIdBCH varchar(80),\n" +
      "  destinationAddress varchar(80),\n" +
      "  signatureProof varchar(140)\n" +
      ");")
}

export async function writeInfoToDb(infoObj){
  try {
    let allKeys = "";
    let allValues = "";
    for (const key in infoObj) {
      allKeys += key + ", ";
      const nextValue =
        typeof infoObj[key] == "string" ? `'${infoObj[key]}'` : infoObj[key];
      allValues += nextValue + ", ";
    }
    allKeys = allKeys.slice(0, -2);
    allValues = allValues.slice(0, -2);

    const query = `INSERT INTO bridge (${allKeys}) VALUES(${allValues}) RETURNING *;`;
    console.log('Executing insert', query)
    await db.run(query);
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}

export async function getAllBridgeInfo(){
  try {
    const result = await getRows(`SELECT * FROM bridge ORDER BY id DESC;`);
    return result.rows;
  } catch (e) {
    console.log(e);
  }
}

export async function getRecentBridgeInfo(){
  try {
    const result = await getRows(`SELECT * FROM bridge ORDER BY id DESC LIMIT 20;`);
    return result.rows;
  } catch (e) {
    console.log(e);
  }
}

export async function bridgeInfoEthAddress(ethAddress){
  try {
    const result = await getRows(`SELECT * FROM bridge WHERE sbchOriginAddress='${ethAddress}'`);
    return result.rows;
  } catch (e) {
    console.log(e);
  }
}

export async function checkAmountBridgedDb() {
  try {
    const result = await getRows(`SELECT * FROM bridge WHERE txIdBCH IS NOT NULL`);
    return result.rows.length;
  } catch (e) {
    console.log(e);
  }
}

export async function addBridgeInfoToNFT(nftNumber, infoObj) {
  try {
    const { timeBridged, signatureProof, txIdBCH, destinationAddress } = infoObj;
    const result = await db.run(
      `UPDATE bridge SET timeBridged='${timeBridged}', signatureProof='${signatureProof}', txIdBCH='${txIdBCH}', destinationAddress='${destinationAddress}' WHERE nftNumber='${nftNumber}' RETURNING *;`
    );
  } catch (e) {
    console.log(e);
  }
}