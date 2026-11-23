// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title AntiScalpingTicketing
 * @notice An event-ticketing system that issues each ticket as an ERC-721 NFT and
 *         enforces anti-scalping rules on-chain: a maximum resale price, a per-account
 *         primary purchase limit, and resale/refund deadlines.
 *
 *         This contract is the deliverable for CSIT5760 "Blockchain and Smart Contracts"
 *         (Individual Project). It demonstrates Solidity 0.8.x, role-based access control,
 *         event-driven interaction, secure Ether handling, and an explicit, testable
 *         state machine for events and tickets.
 */
contract AntiScalpingTicketing is ERC721, AccessControl, Pausable, ReentrancyGuard {
    /* ============================= Roles ============================= */

    bytes32 public constant ORGANISER_ROLE = keccak256("ORGANISER_ROLE");
    bytes32 public constant GATE_CHECKER_ROLE = keccak256("GATE_CHECKER_ROLE");

    /* ============================= Enums ============================= */

    enum EventStatus { Created, OnSale, Ended }
    enum TicketStatus { Minted, Listed, Used, Refunded }

    /* ============================= Structs ============================= */

    struct Event {
        string name;
        uint256 date;              // date of the event itself (informational)
        uint256 saleStartTime;     // when the primary sale opens
        uint256 saleDeadline;      // when the primary sale closes
        uint256 refundDeadline;    // refunds and resale close after this time
        uint256 price;             // face value in wei
        uint256 resaleCap;         // maximum permitted resale price in wei
        uint256 maxPerAccount;     // per-address primary purchase limit
        uint256 maxSupply;         // total tickets available for the event
        uint256 totalMinted;       // tickets minted in the primary sale
        uint256 totalSold;         // cumulative primary + resale transactions
        uint256 proceeds;          // Ether accumulated from primary sales (wei)
        address organiser;
        EventStatus status;
    }

    struct Ticket {
        uint256 eventId;
        address originalOwner;     // primary purchaser; only they may request a refund
        uint256 purchasePrice;     // face value paid in the primary sale
        uint256 issuedAt;
        TicketStatus status;
    }

    struct Listing {
        uint256 ticketId;
        address seller;
        uint256 price;             // listing price, must be <= event.resaleCap
        bool active;
    }

    /* ============================= State ============================= */

    mapping(uint256 => Event) private _events;
    mapping(uint256 => Ticket) private _tickets;
    mapping(uint256 => Listing) private _listings;
    // account -> eventId -> number of primary tickets purchased
    mapping(address => mapping(uint256 => uint256)) private _purchaseCount;
    // ticketId -> active listing id (0 means not listed)
    mapping(uint256 => uint256) private _listingOfTicket;

    uint256 public eventCount;
    uint256 public listingCount;
    uint256 private _ticketCounter;

    /* ============================= Errors ============================= */

    error NotOrganiser();
    error NotHolder();
    error NotOriginalOwner();
    error TicketNonTransferable();
    error IncorrectPayment();
    error TicketSoldOut();
    error ExceedsPurchaseLimit();
    error PriceAboveCap();
    error InvalidPrice();
    error SaleNotOpen();
    error SaleEnded();
    error ResaleClosed();
    error RefundClosed();
    error AlreadyListed();
    error NotListed();
    error CannotBuyOwnTicket();
    error WithdrawalNotAvailable();
    error InvalidDeadlines();
    error InvalidState();

    /* ============================= Events ============================= */

    event EventCreated(
        uint256 indexed eventId,
        address indexed organiser,
        string name,
        uint256 price,
        uint256 resaleCap,
        uint256 maxSupply,
        uint256 maxPerAccount,
        uint256 saleStartTime,
        uint256 saleDeadline,
        uint256 refundDeadline
    );

    event TicketPurchased(
        uint256 indexed eventId,
        uint256 indexed ticketId,
        address indexed buyer,
        uint256 price
    );

    event TicketResold(
        uint256 indexed listingId,
        uint256 indexed ticketId,
        address indexed seller,
        uint256 price
    );

    event ResaleCancelled(
        uint256 indexed listingId,
        uint256 indexed ticketId,
        address indexed seller
    );

    event ResalePurchased(
        uint256 indexed listingId,
        uint256 indexed ticketId,
        address indexed seller,
        address buyer,
        uint256 price
    );

    event RefundRequested(
        uint256 indexed eventId,
        uint256 indexed ticketId,
        address indexed holder,
        uint256 amount
    );

    event TicketUsed(
        uint256 indexed eventId,
        uint256 indexed ticketId,
        address indexed holder
    );

    event Withdrawn(
        uint256 indexed eventId,
        address indexed organiser,
        uint256 amount
    );

    /* ============================= Constructor ============================= */

    constructor(address defaultAdmin)
        ERC721("AntiScalpingTicket", "AST")
    {
        require(defaultAdmin != address(0), "AntiScalpingTicketing: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
    }

    /* ============================= Modifiers ============================= */

    modifier onlyOrganiser() {
        if (!hasRole(ORGANISER_ROLE, msg.sender)) revert NotOrganiser();
        _;
    }

    /* ============================= Admin / Emergency ============================= */

    /// @notice Pauses all state-changing operations. Admin only.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpauses the contract. Admin only.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /* ============================= Organiser ============================= */

    /**
     * @notice Registers a new event and opens its primary sale according to `saleStartTime`.
     */
    function createEvent(
        string calldata name,
        uint256 date,
        uint256 price,
        uint256 resaleCap,
        uint256 maxPerAccount,
        uint256 maxSupply,
        uint256 saleStartTime,
        uint256 saleDeadline,
        uint256 refundDeadline
    )
        external
        onlyOrganiser
        whenNotPaused
    {
        if (bytes(name).length == 0) revert InvalidState();
        if (price == 0) revert InvalidPrice();
        if (resaleCap < price) revert PriceAboveCap(); // cap must at least equal face value
        if (maxPerAccount == 0 || maxSupply == 0) revert InvalidState();
        if (!(saleStartTime < saleDeadline && saleDeadline <= refundDeadline)) {
            revert InvalidDeadlines();
        }

        eventCount += 1;
        uint256 eventId = eventCount;

        Event storage e = _events[eventId];
        e.name = name;
        e.date = date;
        e.price = price;
        e.resaleCap = resaleCap;
        e.maxPerAccount = maxPerAccount;
        e.maxSupply = maxSupply;
        e.saleStartTime = saleStartTime;
        e.saleDeadline = saleDeadline;
        e.refundDeadline = refundDeadline;
        e.organiser = msg.sender;
        e.status = saleStartTime <= block.timestamp
            ? EventStatus.OnSale
            : EventStatus.Created;

        emit EventCreated(
            eventId,
            msg.sender,
            name,
            price,
            resaleCap,
            maxSupply,
            maxPerAccount,
            saleStartTime,
            saleDeadline,
            refundDeadline
        );
    }

    /// @notice Withdraws accumulated primary-sale proceeds once refunds can no longer occur.
    function withdraw(uint256 eventId) external onlyOrganiser whenNotPaused nonReentrant {
        _syncEventStatus(eventId);
        Event storage e = _events[eventId];
        if (e.organiser != msg.sender) revert NotOrganiser();
        if (block.timestamp <= e.refundDeadline) revert WithdrawalNotAvailable();

        uint256 amount = e.proceeds;
        if (amount == 0) revert InvalidState();
        e.proceeds = 0;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert InvalidState();

        emit Withdrawn(eventId, msg.sender, amount);
    }

    /* ============================= Buyer (primary) ============================= */

    /// @notice Purchases one ticket in the primary sale, minting an ERC-721 NFT.
    function purchaseTicket(uint256 eventId) external payable whenNotPaused nonReentrant {
        _syncEventStatus(eventId);
        Event storage e = _events[eventId];

        if (e.status == EventStatus.Created) revert SaleNotOpen();
        if (e.status == EventStatus.Ended) revert SaleEnded();
        if (msg.value != e.price) revert IncorrectPayment();
        if (e.totalMinted >= e.maxSupply) revert TicketSoldOut();
        if (_purchaseCount[msg.sender][eventId] >= e.maxPerAccount) {
            revert ExceedsPurchaseLimit();
        }

        _ticketCounter += 1;
        uint256 ticketId = _ticketCounter;

        _tickets[ticketId] = Ticket({
            eventId: eventId,
            originalOwner: msg.sender,
            purchasePrice: e.price,
            issuedAt: block.timestamp,
            status: TicketStatus.Minted
        });

        _purchaseCount[msg.sender][eventId] += 1;
        e.totalMinted += 1;
        e.totalSold += 1;
        e.proceeds += e.price;

        _safeMint(msg.sender, ticketId);

        emit TicketPurchased(eventId, ticketId, msg.sender, e.price);
    }

    /* ============================= Resale market ============================= */

    /// @notice Lists a Minted ticket on the regulated secondary market at or below the cap.
    function resellTicket(uint256 ticketId, uint256 price)
        external
        whenNotPaused
        nonReentrant
    {
        Ticket storage t = _tickets[ticketId];
        if (msg.sender != ownerOf(ticketId)) revert NotHolder();
        if (t.status != TicketStatus.Minted) revert InvalidState();
        if (_listingOfTicket[ticketId] != 0) revert AlreadyListed();

        _syncEventStatus(t.eventId);
        Event storage e = _events[t.eventId];
        if (block.timestamp > e.refundDeadline) revert ResaleClosed();
        if (price > e.resaleCap) revert PriceAboveCap();
        if (price == 0) revert InvalidPrice();

        listingCount += 1;
        uint256 listingId = listingCount;

        _listings[listingId] = Listing({
            ticketId: ticketId,
            seller: msg.sender,
            price: price,
            active: true
        });
        _listingOfTicket[ticketId] = listingId;
        t.status = TicketStatus.Listed;

        emit TicketResold(listingId, ticketId, msg.sender, price);
    }

    /// @notice Withdraws an active listing, returning the ticket to Minted.
    function cancelResale(uint256 ticketId) external whenNotPaused nonReentrant {
        uint256 listingId = _listingOfTicket[ticketId];
        if (listingId == 0) revert NotListed();

        Listing storage l = _listings[listingId];
        if (msg.sender != ownerOf(ticketId)) revert NotHolder();
        if (!l.active) revert NotListed();

        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.Listed) revert InvalidState();

        l.active = false;
        _listingOfTicket[ticketId] = 0;
        t.status = TicketStatus.Minted;

        emit ResaleCancelled(listingId, ticketId, msg.sender);
    }

    /// @notice Buys an active listing; transfers the NFT and the Ether to the buyer and seller.
    function buyResaleTicket(uint256 listingId)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        Listing storage l = _listings[listingId];
        if (!l.active) revert NotListed();
        if (msg.sender == l.seller) revert CannotBuyOwnTicket();
        if (msg.value != l.price) revert IncorrectPayment();

        uint256 ticketId = l.ticketId;
        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.Listed) revert InvalidState();

        _syncEventStatus(t.eventId);
        Event storage e = _events[t.eventId];
        if (block.timestamp > e.refundDeadline) revert ResaleClosed();

        address seller = l.seller;
        uint256 price = l.price;

        // Effects
        l.active = false;
        _listingOfTicket[ticketId] = 0;
        t.status = TicketStatus.Minted;
        e.totalSold += 1;

        // Interactions: transfer the NFT, then pay the seller (checks-effects-interactions).
        _transfer(seller, msg.sender, ticketId);

        (bool ok, ) = seller.call{value: price}("");
        if (!ok) revert InvalidState();

        emit ResalePurchased(listingId, ticketId, seller, msg.sender, price);
    }

    /* ============================= Refund ============================= */

    /// @notice Refunds the original primary purchaser and burns the ticket (before the deadline).
    function requestRefund(uint256 ticketId) external whenNotPaused nonReentrant {
        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.Minted) revert InvalidState();
        if (msg.sender != ownerOf(ticketId)) revert NotHolder();
        if (msg.sender != t.originalOwner) revert NotOriginalOwner();

        _syncEventStatus(t.eventId);
        Event storage e = _events[t.eventId];
        if (block.timestamp > e.refundDeadline) revert RefundClosed();

        uint256 amount = t.purchasePrice;

        // Effects
        t.status = TicketStatus.Refunded;
        e.proceeds -= amount;

        // Interactions: burn the NFT, then return the Ether.
        _burn(ticketId);

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert InvalidState();

        emit RefundRequested(t.eventId, ticketId, msg.sender, amount);
    }

    /* ============================= Gate validation ============================= */

    /// @notice Marks a ticket as Used at the venue entrance, preventing reuse.
    function validateTicket(uint256 ticketId)
        external
        onlyRole(GATE_CHECKER_ROLE)
        whenNotPaused
    {
        Ticket storage t = _tickets[ticketId];
        if (t.status != TicketStatus.Minted) revert InvalidState();

        t.status = TicketStatus.Used;

        emit TicketUsed(t.eventId, ticketId, ownerOf(ticketId));
    }

    /* ============================= View helpers ============================= */

    function getEvent(uint256 eventId) external view returns (Event memory) {
        return _events[eventId];
    }

    function getTicket(uint256 ticketId) external view returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function purchaseCount(address account, uint256 eventId) external view returns (uint256) {
        return _purchaseCount[account][eventId];
    }

    function listingOfTicket(uint256 ticketId) external view returns (uint256) {
        return _listingOfTicket[ticketId];
    }

    /* ============================= Internal ============================= */

    /// @notice Lazily advances an event through Created -> OnSale -> Ended.
    function _syncEventStatus(uint256 eventId) internal {
        Event storage e = _events[eventId];
        if (e.status == EventStatus.Created && block.timestamp >= e.saleStartTime) {
            e.status = EventStatus.OnSale;
        }
        if (e.status == EventStatus.OnSale && block.timestamp > e.saleDeadline) {
            e.status = EventStatus.Ended;
        }
    }

    /**
     * @notice Tickets are non-transferable by users: resale must go through the
     *         contract's own resale functions so the price cap is always enforced.
     */
    function transferFrom(address, address, uint256)
        public
        pure
        override
    {
        revert TicketNonTransferable();
    }

    function safeTransferFrom(address, address, uint256)
        public
        pure
        override
    {
        revert TicketNonTransferable();
    }

    function safeTransferFrom(address, address, uint256, bytes memory)
        public
        pure
        override
    {
        revert TicketNonTransferable();
    }

    /// @dev Combines ERC-721 and AccessControl interface detection.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
