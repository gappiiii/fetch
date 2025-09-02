// このスクリプトは、実運用に近い一連のフローをローカルネットワークで再現します。
// フロー概要:
//  1) コントラクト(未指定なら自動デプロイ)のオーナーが3つのNFTをフル属性付きでミント
//  2) 3つすべてを PACKAGED 状態へ更新（製造者が梱包/NFC封入した状態）
//  3) user1 が2つ、user2 が1つを activateAndClaim で受け取り、ACTIVATED へ遷移
//  4) 前後の所有状況・主要属性・状態を表示
// 実行例:
//  - 自動デプロイして実行: `npx hardhat run scripts/demoActivateFlow.js --network localhost`
//  - 既存コントラクトで実行: `NFT_ADDRESS=0x... npx hardhat run scripts/demoActivateFlow.js --network localhost`
const hre = require("hardhat");

// ミント時のレシートから Transfer イベントをデコードし、ミントされた tokenId を抽出
// (from=0x0/トークン発行元、to=指定アドレス のログを拾います)
async function extractMintedTokenIds(nft, receipt, to) {
  const ids = [];
  for (const log of receipt.logs || []) {
    try {
      const parsed = nft.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "Transfer") {
        const from = parsed.args?.from;
        const toAddr = parsed.args?.to;
        const tokenId = parsed.args?.tokenId;
        if (
          from && from.toLowerCase() === hre.ethers.ZeroAddress &&
          toAddr && toAddr.toLowerCase() === to.toLowerCase()
        ) {
          ids.push(tokenId.toString());
        }
      }
    } catch (_) {
      // 関係ないログは無視（parseに失敗した場合もスキップ）
    }
  }
  return ids;
}

// 状態(enum)のラベルを人間が読みやすい文字列に変換
function stateLabel(n) {
  const v = Number(n);
  if (v === 0) return "UNKNOWN";
  if (v === 1) return "PACKAGED";
  if (v === 2) return "ACTIVATED";
  return `UNKNOWN(${v})`;
}

// コントラクトアドレスが指定されていない場合、ローカルに新規デプロイ
// 既存アドレスがあればそのまま利用
async function ensureContract(addressEnv, deployer) {
  if (addressEnv) return addressEnv;
  console.log("NFT_ADDRESS not set. Deploying a fresh contract to localhost...");
  const name = process.env.NFT_NAME || "F1_Parts_NFT";
  const symbol = process.env.NFT_SYMBOL || "MNFT";
  const baseURI = process.env.NFT_BASE_URI || "ipfs://YOUR_CID/";
  const F1PartsNFT = await hre.ethers.getContractFactory("F1_Parts_NFT", deployer);
  const nft = await F1PartsNFT.deploy(name, symbol, baseURI);
  await nft.waitForDeployment();
  const addr = await nft.getAddress();
  console.log("Deployed F1_Parts_NFT to:", addr);
  return addr;
}

// 所有状況・簡易属性・状態をまとめて表示するユーティリティ
async function printSummary(nft, label, addresses) {
  console.log(`\n=== ${label} ===`);
  for (const [name, addr] of addresses) {
    const tokenIds = await nft.tokensOfOwner(addr);
    const ids = tokenIds.map((x) => x.toString());
    console.log(`${name} (${addr}) -> tokenIds: [${ids.join(", ")}]`);
    for (const id of tokenIds) {
      const tokenId = id.toString();
      const [s, car, date] = await Promise.all([
        nft.getState(tokenId),
        nft._car_number(tokenId),
        nft._date(tokenId),
      ]);
      console.log(`  - #${tokenId} state=${stateLabel(s)} car=${car} date=${date}`);
    }
  }
}

// 指定 tokenId の「フルデータ（全属性＋URI＋所有者＋状態）」を表示
async function printFullTokenData(nft, tokenId) {
  const id = tokenId.toString();
  const [
    s,
    car,
    date,
    gp,
    circuit,
    corner,
    driver,
    gforce,
    pid,
    img,
    vid,
    uri,
    realOwner,
  ] = await Promise.all([
    nft.getState(id),
    nft._car_number(id),
    nft._date(id),
    nft._gp_name(id),
    nft._circuit(id),
    nft._corner(id),
    nft._driver(id),
    nft._estimated_g(id),
    nft._physical_id(id),
    nft._imageURI(id),
    nft._videoURI(id),
    nft.tokenURI(id),
    nft.ownerOf(id),
  ]);

  console.log(`\n# Token ${id}`);
  console.log(`  owner: ${realOwner}`);
  console.log(`  state: ${stateLabel(s)} (${s})`);
  console.log(`  car_number: ${car}`);
  console.log(`  date: ${date}`);
  console.log(`  gp_name: ${gp}`);
  console.log(`  circuit: ${circuit}`);
  console.log(`  corner: ${corner}`);
  console.log(`  driver: ${driver}`);
  console.log(`  estimated_g: ${gforce}`);
  console.log(`  physical_id: ${pid}`);
  console.log(`  imageURI: ${img}`);
  console.log(`  videoURI: ${vid}`);
  console.log(`  tokenURI: ${uri}`);
}

async function main() {
  const [owner, user1, user2] = await hre.ethers.getSigners();
  const contractAddress = await ensureContract(process.env.NFT_ADDRESS, owner);
  const nft = await hre.ethers.getContractAt("F1_Parts_NFT", contractAddress, owner);

  console.log("\nActors:");
  console.log("- owner:", owner.address);
  console.log("- user1:", user1.address);
  console.log("- user2:", user2.address);

  // 3件分のサンプル属性(FullData)を用意
  const payloads = [
    {
      carNumber: "CAR-001",
      date: "2024-09-01",
      gpName: "Japanese GP",
      circuit: "Suzuka",
      corner: "130R",
      driver: "Driver A",
      estimatedG: "5.4G",
      physicalId: "PID-001",
    },
    {
      carNumber: "CAR-002",
      date: "2024-09-02",
      gpName: "Italian GP",
      circuit: "Monza",
      corner: "Parabolica",
      driver: "Driver B",
      estimatedG: "5.0G",
      physicalId: "PID-002",
    },
    {
      carNumber: "CAR-003",
      date: "2024-09-03",
      gpName: "Monaco GP",
      circuit: "Monaco",
      corner: "Rascasse",
      driver: "Driver C",
      estimatedG: "4.8G",
      physicalId: "PID-003",
    },
  ];

  // 1) オーナーが自分宛に3枚ミント（フル属性付き）
  const mintedIds = [];
  for (const d of payloads) {
    const tx = await nft.mintWithFullData(owner.address, d);
    const rc = await tx.wait();
    const ids = await extractMintedTokenIds(nft, rc, owner.address);
    if (!ids.length) throw new Error("Failed to detect minted tokenId");
    mintedIds.push(ids[0]);
  }
  console.log("Minted tokenIds:", mintedIds.join(", "));

  // 2) 3枚すべてを PACKAGED 状態へ（NFC封入/梱包済みを表す）
  for (const id of mintedIds) {
    const tx = await nft.setPackaged(id);
    await tx.wait();
  }
  console.log("Packaged tokenIds:", mintedIds.join(", "));

  await printSummary(
    nft,
    "ミント+パッケージ後（owner が全て保有・state=PACKAGED）",
    [
      ["owner", owner.address],
      ["user1", user1.address],
      ["user2", user2.address],
    ]
  );

  // 3) user1 が2つ、user2 が1つをアクティベート受領（製造者からユーザーへ移転しつつ ACTIVATED）
  const [id1, id2, id3] = mintedIds;
  await (await nft.connect(user1).activateAndClaim(id1)).wait();
  await (await nft.connect(user1).activateAndClaim(id2)).wait();
  await (await nft.connect(user2).activateAndClaim(id3)).wait();
  console.log("Activated:", `${id1}, ${id2} by user1; ${id3} by user2`);

  await printSummary(
    nft,
    "最終（user1 が2枚ACTIVATED、user2 が1枚ACTIVATED）",
    [
      ["owner", owner.address],
      ["user1", user1.address],
      ["user2", user2.address],
    ]
  );

  // 4) 3つのNFTのフルデータを表示
  console.log("\n=== 3つのNFTのフルデータ ===");
  for (const id of mintedIds) {
    await printFullTokenData(nft, id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
