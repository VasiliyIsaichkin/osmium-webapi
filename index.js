const Events = require('osmium-events');
const tools = require('osmium-tools');

class WebApi extends Events {
	constructor(socket, isServer, options) {
		super();

		this.options = Object.assign({
			prefix     : 'webApi',
			eventCmd   : 'command',
			eventCmdRet: 'return'
		}, options);

		this.isServer = isServer;

		const constructEventName = (_isServer, isCmd) =>
			`${this.options.prefix}|${_isServer ? 'server' : 'client'}|${isCmd ? this.options.eventCmd : this.options.eventCmdRet}`;

		Object.assign(this.options, {
			version         : 1,
			cmdToTarget     : constructEventName(isServer, true),
			cmdToTargetRet  : constructEventName(isServer, false),
			cmdFromTarget   : constructEventName(!isServer, true),
			cmdFromTargetRet: constructEventName(!isServer, false)
		});

		this.socket = socket;
		this.socketEvents = new Events();

		this.socket.on(this.options.cmdToTargetRet, (packet) => {
			if (!tools.isGUID(packet.id) && packet.version !== this.options.version) return;
			this.socketEvents.emit(packet.id, packet.args);
		});

		this.use((name, options, ...args) => {
			if (options.skipWebApiHandler) return tools.nop;
			const id = tools.GUID();
			const promise = new Promise((resolve) => {
				//@todo: add garbage collecotor here (delete unused calls after timeout)
				this.socketEvents.once(id, (ret) => {
					resolve({ret});
				});
			});

			this.socket.emit(this.options.cmdToTarget, {
				id,
				name,
				args,
				version: this.options.version
			});
			return promise;
		});

		this.socket.on(this.options.cmdFromTarget, async (packet) => {
			if (!packet.name || !tools.isGUID(packet.id) || packet.version !== this.options.version) return;
			await this.emitEx(packet.name, true, {skipWebApiHandler: true, webApiPacketId: packet.id}, ...(tools.isArray(packet.args) ? packet.args : [packet.args]));
		});

		this.useAfter((name, mwConfig, ret) => {
			if (!tools.isObject(ret) || !mwConfig.webApiPacketId) return;
			const args = Object.keys(ret).length === 1
			             ? ret[Object.keys(ret)[0]]
			             : tools.objectToArray(ret);
			this.socket.emit(this.options.cmdFromTargetRet, {name, id: mwConfig.webApiPacketId, args, version: this.options.version});
		});
	}
}

class WebApiServer extends Events {
	constructor(io, options) {
		super(true);
		this.options = Object.assign({
			emitTimeout: 5000
		}, options);

		this.handlers = {};
		this.use(async (name, options, ...args) => {
			let promises = [];
			if (options.fromMapper) return;
			tools.iterate(this.handlers, (handler, hid) => {
				promises.push(new Promise(async (resolve) => {
					setTimeout(() => resolve({timeout: true, hid}), this.options.emitTimeout);
					resolve({ret: await handler.emit(name, ...args), timeout: false, hid});
				}));
			});
			const ret = tools.iterate(await Promise.all(promises), (row, _, iter) => {
				iter.key(row.hid);
				return row.timeout ? null : row.ret;
			}, {});
			return {ret};
		});

		io.on('connection', (socket) => this.registerHandler(socket));
	};

	registerHandler(socket) {
		socket.on('disconnect', () => this.unRegisterHandelr(socket));
		this.handlers[socket.id] = new WebApi(socket, true);
		this.handlers[socket.id].mapEvents(this);
	};

	unRegisterHandelr(socket) {
		delete this.handlers[socket.id];
	}
}

class WebApiClient extends WebApi {
	constructor(socket) {
		super(socket, false);
	}

	ready() {
		return new Promise((resolve) => this.socket.on('connect', resolve));
	}
}

module.exports = {
	WebApi,
	WebApiServer,
	WebApiClient
};