// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PonsLaunchParams, PonsSocials, PonsLaunchedToken, IPonsFactory, IPonsCurve, PonsAddrs} from "./PonsTypes.sol";

interface ITipJarF {
    function initialize(string calldata handle) external;
    function sweepCurve(address curve) external returns (bool);
    function harvest() external returns (uint256 claimed, uint256 bought);
}

/// @title Stock Tips factory
/// Opens Pons coins for X handles. Every coin is launched on Pons by this contract, so the contract is the Pons deployer
/// (the only account that may sweep curve fees) and the handle's TipJar is the creator fee recipient. Creator tax is 3%
/// and never changes. Anyone can open a coin for any handle; only the owner of the handle can ever receive the jar.
/// The owner of this contract is the guardian: it can pause new coins, rotate the oracle after a 48 hour notice and cancel
/// a pending jar binding. It cannot move fees, NVDA or ETH.
contract TipFactory {
    uint16 public constant CREATOR_TAX_BPS = 300;
    uint256 public constant ORACLE_DELAY = 48 hours;

    address public immutable jarImpl;
    address public guardian;
    address public pendingGuardian;
    address public oracle;
    address public nextOracle;
    uint64 public nextOracleAt;
    address public burner;
    bool public paused;

    struct Coin {
        address token;
        address curve;
        address jar;
        address opener;
        uint64 createdAt;
    }

    Coin[] internal _coins;
    mapping(address => uint256) public coinIndex;
    mapping(bytes32 => address) public jarOf;
    mapping(bytes32 => uint256[]) internal _coinsOf;
    uint256 public jarCount;

    event JarCreated(bytes32 indexed handleHash, address jar, string handle);
    event CoinOpened(address indexed token, address indexed jar, address indexed opener, string handle, string name, string symbol);
    event Swept(address indexed token, bool ok);
    event OracleProposed(address oracle, uint64 activeAt);
    event OracleSet(address oracle);
    event Paused(bool paused);
    event GuardianTransferred(address indexed previous, address indexed next);

    modifier onlyGuardian() {
        require(msg.sender == guardian, "guardian");
        _;
    }

    constructor(address _jarImpl, address _oracle, address _burner) {
        require(_jarImpl != address(0) && _oracle != address(0) && _burner != address(0), "zero");
        jarImpl = _jarImpl;
        oracle = _oracle;
        burner = _burner;
        guardian = msg.sender;
    }

    /// Lowercase X handle, 1 to 15 characters of a-z, 0-9 and underscore.
    function validHandle(string memory handle) public pure returns (bool) {
        bytes memory b = bytes(handle);
        if (b.length == 0 || b.length > 15) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) return false;
        }
        return true;
    }

    /// Opens a coin for `handle` on Pons. msg.value must be exactly the Pons launch fee.
    function openCoin(string calldata handle, string calldata name, string calldata symbol, string calldata logo, string calldata description) external payable returns (address token, address jar) {
        require(!paused, "paused");
        require(validHandle(handle), "handle");
        IPonsFactory pons = IPonsFactory(PonsAddrs.FACTORY);
        require(msg.value == pons.launchFee(), "launch fee");
        bytes32 h = keccak256(bytes(handle));
        jar = jarOf[h];
        if (jar == address(0)) {
            jar = _clone(jarImpl);
            ITipJarF(jar).initialize(handle);
            jarOf[h] = jar;
            jarCount++;
            emit JarCreated(h, jar, handle);
        }
        PonsLaunchParams memory p = PonsLaunchParams({
            name: name,
            symbol: symbol,
            logo: logo,
            description: description,
            socials: PonsSocials({twitter: string.concat("https://x.com/", handle), telegram: "", discord: "", website: "", farcaster: ""}),
            creatorFeeRecipient: jar,
            creatorTaxBps: CREATOR_TAX_BPS,
            buybackEnabled: false,
            expectedEconomics: pons.previewLaunchEconomics(0, address(0)),
            salt: keccak256(abi.encode(h, _coins.length, block.timestamp))
        });
        address curve;
        (token, curve) = pons.launchToken{value: msg.value}(p, 0, address(0));
        _coins.push(Coin(token, curve, jar, msg.sender, uint64(block.timestamp)));
        coinIndex[token] = _coins.length;
        _coinsOf[h].push(_coins.length - 1);
        emit CoinOpened(token, jar, msg.sender, handle, name, symbol);
    }

    /// Moves curve fees of coins still on their Pons curve into the escrow of their jars. Anyone can call it.
    function sweep(address[] calldata tokens) public {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 idx = coinIndex[tokens[i]];
            if (idx == 0) continue;
            Coin storage c = _coins[idx - 1];
            PonsLaunchedToken memory lt = IPonsFactory(PonsAddrs.FACTORY).getLaunchedToken(c.token);
            if (lt.phase >= 2) continue;
            emit Swept(c.token, ITipJarF(c.jar).sweepCurve(c.curve));
        }
    }

    /// Sweeps those coins and then harvests each jar they belong to, in one call. Anyone can call it.
    function sweepAndHarvest(address[] calldata tokens) external {
        sweep(tokens);
        address[] memory done = new address[](tokens.length);
        uint256 n;
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 idx = coinIndex[tokens[i]];
            if (idx == 0) continue;
            address jar = _coins[idx - 1].jar;
            bool seen;
            for (uint256 j = 0; j < n; j++) if (done[j] == jar) { seen = true; break; }
            if (seen) continue;
            done[n++] = jar;
            ITipJarF(jar).harvest();
        }
    }

    // ---------------------------------------------------------------- guardian

    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit Paused(p);
    }

    /// A new oracle only takes effect after a public 48 hour notice.
    function proposeOracle(address next) external onlyGuardian {
        require(next != address(0), "zero");
        nextOracle = next;
        nextOracleAt = uint64(block.timestamp + ORACLE_DELAY);
        emit OracleProposed(next, nextOracleAt);
    }

    function activateOracle() external {
        require(nextOracle != address(0) && block.timestamp >= nextOracleAt, "wait");
        oracle = nextOracle;
        nextOracle = address(0);
        nextOracleAt = 0;
        emit OracleSet(oracle);
    }

    function transferGuardian(address next) external onlyGuardian {
        pendingGuardian = next;
    }

    function acceptGuardian() external {
        require(msg.sender == pendingGuardian, "pending");
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    // ---------------------------------------------------------------- views

    function coinCount() external view returns (uint256) {
        return _coins.length;
    }

    function coins(uint256 from, uint256 count) external view returns (Coin[] memory list) {
        uint256 n = _coins.length;
        if (from >= n) return new Coin[](0);
        uint256 end = from + count > n ? n : from + count;
        list = new Coin[](end - from);
        for (uint256 i = from; i < end; i++) list[i - from] = _coins[i];
    }

    function coinsOf(string calldata handle) external view returns (Coin[] memory list) {
        uint256[] storage ids = _coinsOf[keccak256(bytes(handle))];
        list = new Coin[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) list[i] = _coins[ids[i]];
    }

    function jarFor(string calldata handle) external view returns (address) {
        return jarOf[keccak256(bytes(handle))];
    }

    function _clone(address impl) internal returns (address inst) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            inst := create(0, ptr, 0x37)
        }
        require(inst != address(0), "clone");
    }
}
