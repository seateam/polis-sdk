import {
    createAsyncMiddleware,
    JsonRpcEngine,
    JsonRpcRequest,
    JsonRpcResponse,
    PendingJsonRpcResponse
} from "json-rpc-engine";
import { BridgeTransactionInfo, DomainTransactionInfo, IPolisProviderOpts, TransactionInfo } from "./types";
import httpRequest from "./utils/httpRequest";
import dialog, { showLoading } from "./utils/dialog";
import createPolisConnectMiddleware from "./polisConnectMiddleware";
import { PolisEvents, WALLET_TYPES } from "./utils";
import mmWallet, { checkMetaMaskInstall, signMessage } from './metaMaskWallet';

// import wc from "./wallectConnector";
import axios from "axios";
import { PolisOauth2Client } from "./PolisOauth2Client";
import Swal from "sweetalert2";
import errors from "./erros";
import WalletConnect from "@walletconnect/client";
import wallectConnector from "./wallectConnector";
import log from "./utils/log"
import sdkErrors from "./erros";
import { TX_TYPE } from "../provider/utils";

let _nextId = 1;

/**
 *
 */
export class PolisProvider extends JsonRpcEngine {
    _confirmUrl: string = '';
    _apiHost: string = '';
    _chainId: number = -1;
    _wallet_type: string = '';
    // private _eventManager: EventManager = new EventManager();
    _polisOauth2Client?: PolisOauth2Client;
    swalPromise: any = null;
    _wcConnector: WalletConnect | undefined;
    _bridgeTx: boolean = false;
    providerOpts: IPolisProviderOpts = {
        apiHost: "",
        chainId: -1,
        maxAttempts: 5,
        token: "",
        // showLoading:false,
    }
    loadingDialog: any;
    
    constructor(opts: IPolisProviderOpts, polisOauth2Client?: PolisOauth2Client) {
        super()
        
        if (!opts.apiHost || opts.apiHost.length <= 0) {
            this._apiHost = "https://polis.metis.io";
        } else {
            if (!opts.apiHost.endsWith('/')) {
                this._apiHost = this._apiHost + '/'
            }
            this._apiHost = opts.apiHost;
        }
        this._chainId = opts.chainId;
        this._polisOauth2Client = polisOauth2Client;
        this.providerOpts = opts;
        this.initWallet();
    }
    
    //region properties
    get token() {
        return this.providerOpts.token;
    }
    
    
    get confirmUrl() {
        return `${this.apiHost}#/oauth2/confirm`;
    }
    
    get bridgeUrl() {
        return `${this.apiHost}#/oauth2/bridge`;
    }
    
    get rpcUrl() {
        return `${this.apiHost}api/rpc/v1`;
    }
    
    get chainId() {
        return this._chainId;
    }
    
    set chainId(value) {
        this._chainId = value;
    }
    
    get apiHost() {
        return this._apiHost;
    }
    
    get walletType() {
        return this._wallet_type;
    }
    
    //endregion properties
    
    static defaultUrl(): string {
        return "http:/\/localhost:8545";
    }
    
    public request(request: { method: string, params?: Array<any> }): Promise<any> {
        const req: JsonRpcRequest<any> = {
            method: request.method,
            params: request.params,
            id: (_nextId++),
            jsonrpc: "2.0",
        };
        const self = this;
        return new Promise<any>((resolve, reject) => {
            this.handle(req, function (err, response: any) {
                
                if (err) {
                    reject(err)
                } else {
                    resolve(response.result)
                }
            })
        })
    }
    
    public connect(token: string,  bridgeMetamask: boolean = true,needWcSession: boolean = false) {
        this._bridgeTx = bridgeMetamask;
        this.providerOpts.token = token;
        //if (!bridgeMetamask) {
        if (needWcSession) {
            this.initWcConnector(true);
        }
        this.initWallet()
    }
    
    private initWcConnector(init = false) {
        if (!this._wcConnector || init) {
            this._wcConnector = wallectConnector.getWalletConnector();
        }
        if (!this._wcConnector.connected) {
            this._wcConnector.createSession();
        }
    }
    
    /**
     *
     */
    private initWallet() {
        const self = this;
        
        this.push(async (req, res, next, end) => {
            
            if (req.method === 'eth_chainId') {
                res.result = self.chainId;
                end();
            }
            if (req.method === 'personal_sign') {
                this.emit('debug', `signMessage: ${JSON.stringify(res)}`);
                // const result:any = res.result;
                // if (result['signMsg'] !== '') {
                //     res.result = result['signMsg'];
                // } else {
                res.result = await this.signMessage(req, res, this._wallet_type);
                // }
                end();
            }
            next();
        });
        // refresh token auto
        if (this._polisOauth2Client) {
            this.push(async (req, res, next, end) => {
                await this.handleRefreshTokenAsync();
            });
        }
        //
        this.push(this.createPolisWallet());
        this.push(createPolisConnectMiddleware(this.providerOpts, this));
        
        this.push(async (req, res, next, end) => {
            log.debug("request:{},response:{}", req, res);
            if (req.method === 'eth_accounts') {
                this.emit('debug', `eth_accounts => ${JSON.stringify(res)}`);
                const result: any = res.result;
                if (result.length === 2) {
                    res.result = [result[0]];
                    this._wallet_type = result[1];
                    if (this._wallet_type === 'METAMASK') {
                        mmWallet.addMetamaskEventCallback(PolisEvents.CHAIN_CHANGED_EVENT, (chainId: any) => {
                            this.emit(PolisEvents.CHAIN_CHANGED_EVENT, chainId);
                        });
                        mmWallet.addMetamaskEventCallback(PolisEvents.ACCOUNTS_CHANGED_EVENT, (address: any) => {
                            this.emit(PolisEvents.ACCOUNTS_CHANGED_EVENT, address);
                        });
                    } else {
                        mmWallet.addMetamaskEventCallback(PolisEvents.CHAIN_CHANGED_EVENT, null);
                        mmWallet.addMetamaskEventCallback(PolisEvents.ACCOUNTS_CHANGED_EVENT, null);
                    }
                }
            }
            end();
        });
    }
    
    private createPolisWallet() {
        // return createWalletMiddleware(getPolisWallet())
        return createAsyncMiddleware(async (req, res: any, next) => {
            if (req.method == 'eth_sendTransaction') {
                await this.confirmTrans(req, res); //res
                this.emit(PolisEvents.TX_CONFIRM_EVENT, Object.assign({}, {action: 'after confirmTrans'}, res));
            } else {
                next()
            }
        })
    }
    
    /**
     * mm, wc, polis
     * @param res
     */
    async confirmTrans(req: any, res: any) {
        
        //if reject what polisTX
        let walletType = "";
        try {
            const estimateTx:DomainTransactionInfo = await this.estimatePolisTrans(req);
    
            if (this._bridgeTx || this.walletType == WALLET_TYPES.LOCAL || this.walletType == WALLET_TYPES.POLIS) {
                return   this.confirmTransBridge(req, res,estimateTx);
            }
            walletType = estimateTx.walletType;
            this.emit(PolisEvents.TX_CONFIRM_EVENT, Object.assign({}, {action: 'polis response estimate done'}, estimateTx));
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType, action: 'open'});
            const sendTx = estimateTx;
            if (sendTx != undefined && sendTx.act && sendTx.act === 'SIGN') {
                log.debug("_bridgeMetamask:", this._bridgeTx)
                if (sendTx.walletType == 'METAMASK') {
                    let confirmData: any;
                    // const metaTxHash = await this.metaMaskSendTransaction(this.chainId, estimateTx);
                    if (this._bridgeTx) {
                        const postData = Object.assign(sendTx, {txType: TX_TYPE.SEND_TX});
                        confirmData = await this.polisBridgePage(postData)
                        let savedTx: any;
                        log.debug("confirmData:", confirmData)
                        if (typeof (confirmData) == 'object') { //domain
                            try {
                                savedTx = await this.saveTx(this.apiHost, this.token ? this.token : "", 'save_app_tx', confirmData, true);
                                this.emit('debug', Object.assign({}, {action: 'save-tx'}, savedTx));
                                if (savedTx == null) {
                                    // server save tx error ,also return but status = IN_PROGRESSING because tx had success
                                    savedTx = {
                                        tx: confirmData,
                                        status: 'SERVER_ERROR',
                                        chainId: estimateTx.chainId,
                                        domain: estimateTx.domain,
                                        data: 'ok',
                                        act: 'CREATE',
                                        value: estimateTx.value,
                                    };
                                    this.emit('warning', Object.assign({}, {action: 'save-tx error'}, confirmData));
                                    
                                }
                            } catch (e) {
                                log.warn(e)
                                this.emit('warning', Object.assign({}, {action: 'save-tx error'}, e));
                            }
                            this.emit('debug', Object.assign({}, {action: 'save-tx surccess'}, savedTx));
                        }
                        res.result = confirmData.trans.txhash;
                    }
                    else {
                        const metaTxHash = await this.metaMaskSendTransaction(this.chainId, estimateTx);
                        res.result = metaTxHash;
                    }
                }
                else if (sendTx.walletType == 'WALLETCONNECT') {
                    const wcTxHash = await this.walletConnectSendTransaction(this.chainId, estimateTx);
                    res.result = wcTxHash;
                }
                else {
                    res.result = '';
                    res.error = sdkErrors.UNKNOW_ERROR;
                }
            }
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType, action: 'close'});
        } catch (e) {
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType, action: 'close'});
            res.error = e;
            this.emit('error', e)
        }
    }
    
    async confirmTransBridge(req: any, res: any,estimateTx:DomainTransactionInfo) {
        try{
            const walletType = this.walletType;
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType, action: 'open'});
            let confirmData;
            switch (this.walletType) {
                case WALLET_TYPES.POLIS:
                case WALLET_TYPES.LOCAL:
                    if (this.token) {
                        confirmData = await this.polisConfirm(estimateTx, this.token, this.confirmUrl)
                    } else {
                        res.error = sdkErrors.TOKEN_IS_EMPTY
                    }
                    break;
                case WALLET_TYPES.WC:
                case WALLET_TYPES.MM:
                    confirmData = await this.polisBridgePage(estimateTx)
                    break;
                default:
                    break;
            }
            if (confirmData.code == 200 && (confirmData.data.act == 'CREATE' || confirmData.data.act== "SUCCESS" )) {
                res.result = confirmData.data.tx;
            }else{
                res.error = confirmData.data.message;
            }
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType, action: 'close'});
            // log.debug("confirmData:", confirmData);
            if (this.walletType!=WALLET_TYPES.POLIS &&  typeof (confirmData) == 'object') {
                try {
                    let savedTx: any;
                    savedTx = await this.saveTx(this.apiHost, this.token ? this.token : "", 'save_app_tx', confirmData.data, true);
                    this.emit('debug', Object.assign({}, {action: 'save-tx'}, savedTx));
                    if (savedTx == null) {
                        this.emit('debug', Object.assign({}, {action: 'save-tx error'}, confirmData));
                    }
                } catch (e) {
                    log.warn(e)
                    this.emit('debug', Object.assign({}, {action: 'save-tx error'}, e));
                }
            }
        }catch (e:any) {
            this.emit(PolisEvents.TX_CONFIRM_DIALOG_EVENT, {walletType:this.walletType, action: 'close'});
    
            if(e && e.message){
                res.error = e.message
            }else{
                res.error  = e;
            }
        }
    }
    
    async signMessage(req: any, res: any, walletType: string) {
        let signMsg: any;
        if (this._bridgeTx || walletType == WALLET_TYPES.LOCAL || walletType == WALLET_TYPES.POLIS) {
            let postData = {
                signContent: req.params[0],
                txType: TX_TYPE.SIGN,
                accessToken: this.token ? this.token : "",
                walletType: walletType,
            }
            signMsg = await this.polisBridgePage(postData);
            return signMsg.data;
        }
        
        if (walletType == "METAMASK") {
            if (!mmWallet.checkMetaMaskInstall()) {
                this.emit("error", "metamask not install.")
                return Promise.reject(errors.MM_NOT_INSTALL);
            }
            signMsg = await mmWallet.signMessage(req.params[0]);
            return signMsg;
        } else if (walletType == "WALLETCONNECT") {
            this.initWcConnector();
            if (this._wcConnector) {
                const signMsg = wallectConnector.signMessage(this._wcConnector, req.params[0]);
                return signMsg;
            }
        }
        return Promise.reject(errors.ACCOUNT_NOT_EXIST);
        
    }
    
    async getChainUrl(chainId: number): Promise<any> {
        return await this.post('chainurl', {chainId});
    }
    
    private async estimatePolisTrans(req: any): Promise<any> {
        const headers = {
            "Access-Token": this.token,
            "chainId": this.chainId,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        }
        this.emit('debug', Object.assign({}, {action: 'estimatePolisTrans request', 'rpcUrl': this.rpcUrl}, req));
        
        const response = await httpRequest.instance.post(this.rpcUrl, req, {headers});
        this.emit('debug', Object.assign({}, {action: 'estimatePolisTrans response'}, response));
        if (response.status == 200 && response.data.result) {
            return Promise.resolve(response.data.result)
        } else {
            return Promise.reject(response.data.error);
        }
    }
    
    private async polisConfirm(tx: DomainTransactionInfo, accessToken: string, confirmUrl: string): Promise<any> {
        // open a dialog
        const transObj:BridgeTransactionInfo = {
            chainId: tx.chainId,
            from: tx.from,
            to: tx.to,
            value: tx.value,
            data: tx.data,
            gasLimit:tx.gasLimit,
            gasPrice: tx.gasPrice,
            fee: tx.fee,
            feeTxt:tx.feeTxt,
            walletType: tx.walletType,
            txType: tx.txType,
            accessToken:accessToken,
            symbol: tx.symbol,
            act:tx.act,
            blsWalletOpen:tx.blsWalletOpen,
        };
        let width = 720;
        let height = 480;
        
        const confirmWin = dialog.fire({
            title: '<span style="font-size: 24px;font-weight: bold;color: #FFFFFF;font-family: Helvetica-Bold, Helvetica">Request Confirmation</span>',
            html: `<iframe src="${confirmUrl}" style="width: 100%; height: ${height}px;" frameborder="0" id="metisConfirmIframe"></iframe>`,
            width: `${width}px`,
            showConfirmButton: false,
            background: '#00004D',
            didOpen: (dom) => {
                document.getElementById('metisConfirmIframe')!.onload = function () {
                    (document.getElementById('metisConfirmIframe') as HTMLIFrameElement).contentWindow!.postMessage(transObj, confirmUrl.split('/#')[0]);
                };
            },
            didClose: () => {
                window.postMessage({status: 'ERROR', code: 1000, message: 'CANCEL'}, window.location.origin);
            },
        });
        const self = this;
        return new Promise((resolve, reject) => {
            function globalMessage(event: any) {
                // log.debug(`event confirm: ${JSON.stringify(event.data)}`);
                if (event.origin !== 'https://polis.metis.io'
                    && event.origin !== 'https://polis-test.metis.io'
                    && event.origin !== 'https://test-polis.metis.io'
                    && event.origin !== 'http://localhost:1024' && event.origin + "/" != self.apiHost && event.origin !== window.location.origin) {
                    return;
                }
                if (event.data && event.data.status) {
                    if (event.data.status === 'ERROR' || event.data.status === 'DECLINE' || event.data.status === 'FAILED') {
                        reject(event.data);
                    } else {
                        resolve(event.data);
                    }
                    window.removeEventListener('message', globalMessage, false);
                    dialog.close(self.swalPromise);
                }
            }
            
            window.addEventListener('message', globalMessage, false);
        });
    }
    
    /**
     * send meatamask wallet connect to polis website
     * @param data
     * @private
     */
    private async polisBridgePage(data: any): Promise<any> {
        const bridgeUrl = this.bridgeUrl;
        const height = 0;
        const confirmWin = dialog.fire({
            title: '',
            html: `<iframe src="${bridgeUrl}" style="width: 100%; height: ${height}px;" frameborder="0" id="polisBridgeIframe"></iframe>`,
            width: `${height}px`,
            showConfirmButton: false,
            background: '#00004D',
            didOpen: (dom:any) => {
                document.getElementById('polisBridgeIframe')!.onload = function () {
                // (document.getElementById('polisBridgeIframe') as HTMLIFrameElement).contentWindow!.document.addEventListener("DOMContentLoaded",function () {
                    (document.getElementById('polisBridgeIframe') as HTMLIFrameElement).contentWindow!.postMessage(data, bridgeUrl.split('/#')[0]);
                // })
                //     console.log("iframe",document.getElementById('polisBridgeIframe'));
                //     (dom.ownerDocument.getElementById('polisBridgeIframe') as HTMLIFrameElement).contentWindow!.postMessage(data, bridgeUrl.split('/#')[0]);
               
                };
            },
            didClose: () => {
                window.postMessage({status: 'ERROR', code: 1000, message: 'CANCEL'}, window.location.origin);
            },
        });
        const self = this;
        return new Promise((resolve, reject) => {
            function globalMessage(event: any) {
                if (event.origin !== 'https://polis.metis.io'
                    && event.origin !== 'https://polis-test.metis.io'
                    && event.origin !== 'https://test-polis.metis.io'
                    && event.origin !== 'http://localhost:1024' && event.origin + "/" != self.apiHost && event.origin !== window.location.origin) {
                    return;
                }
                log.debug(`event confirm: ${JSON.stringify(event.data)}`);
                if (event.data && event.data.status) {
                    if (event.data.status === 'ERROR' || event.data.status === 'DECLINE' || event.data.status === 'FAILED') {
                        reject(event.data);
                    } else {
                        resolve(event.data);
                    }
                    window.removeEventListener('message', globalMessage, false);
                    dialog.close(self.swalPromise);
                }
            }
            
            window.addEventListener('message', globalMessage, false);
        });
    }
    
    private async metaMaskSendTransaction(chainId: number, tx: any) {
        if (!this.token) {
            //todo not auth
            return null;
        }
        const chainObj = await this.getChainUrl(chainId);
        if (!mmWallet.checkMetaMaskInstall()) {
            this.emit("error", "metamask not install.")
            return Promise.reject(errors.MM_NOT_INSTALL);
        }
        const res = await mmWallet.sendMetaMaskTrans(tx, chainObj);
        let savedTx: any;
        if (res != null) {
            if (typeof (res) == 'object') { //domain
                try {
                    savedTx = await this.saveTx(this.apiHost, this.token, 'save_app_tx', res, true);
                    this.emit('debug', Object.assign({}, {action: 'save-tx'}, savedTx));
                    if (savedTx == null) {
                        // server save tx error ,also return but status = IN_PROGRESSING because tx had success
                        savedTx = {
                            tx: res,
                            status: 'SERVER_ERROR',
                            chainId: tx.chainId,
                            domain: tx.domain,
                            data: 'ok',
                            act: 'CREATE',
                            value: tx.value,
                        };
                        this.emit('warning', Object.assign({}, {action: 'save-tx error'}, res));
                        return new Promise<any>((resolve, reject) => {
                            resolve(res.trans.txhash);
                        });
                    }
                } catch (e) {
                    log.warn(e)
                    this.emit('warning', Object.assign({}, {action: 'save-tx error'}, e));
                    return Promise.resolve(res.trans.txhash);
                }
                this.emit('debug', Object.assign({}, {action: 'save-tx surccess'}, savedTx));
                return Promise.resolve(res.trans.txhash);
            }
            
            return new Promise<any>((resolve, reject) => {
                resolve(res);
            });
        } else {
            // error(res?.data);
            return Promise.reject(errors.MM_ERROR);
        }
    }
    
    private async walletConnectSendTransaction(chainId: number, tx: any) {
        if (!this.token) {
            //todo not auth
            return Promise.reject(errors.TOKEN_IS_EMPTY);
        }
        this.initWcConnector();
        if (this._wcConnector) {
            const txhash = await wallectConnector.sendTrans(this._wcConnector,
                tx);
            const recipt = '';
            let savedTx: any;
            tx.domain = '';
            try {
                savedTx = await this.saveTx(this.apiHost, this.token, 'save_app_tx', tx, true);
                this.emit('debug', Object.assign({}, {action: 'save-tx'}, savedTx));
                if (savedTx == null) {
                    // server save tx error ,also return but status = IN_PROGRESSING because tx had success
                    savedTx = {
                        tx: txhash,
                        status: 'SERVER_ERROR',
                        chainId: tx.chainId,
                        domain: tx.domain,
                        data: 'ok',
                        act: 'CREATE',
                        value: tx.value,
                    };
                    this.emit('warning', Object.assign({}, {action: 'save-tx error'}, savedTx));
                    return Promise.resolve(txhash);
                    // return new Promise<any>((resolve, reject) => {
                    //     reject(savedTx);
                    // });
                }
            } catch (e) {
                this.emit('warning', Object.assign({}, {action: 'save-tx error'}, e));
                return Promise.resolve(txhash);
            }
            this.emit('debug', Object.assign({}, {action: 'save-tx surccess'}, savedTx));
            return Promise.resolve(txhash);
        }
    }
    
    async queryPolisTxAsync(chainId: number, tx: string, disableTooltip?: boolean): Promise<any> {
        const headers = {
            'Content-Type': 'application/json',
            'Access-Token': this.token,
        };
        await this.handleRefreshTokenAsync();
        // const r = new request(!disableTooltip);
        const res = await httpRequest.instance.post(this.apiHost + `/api/v1/oauth2/query_tx`, {
            chainId,
            tx,
        }, {headers});
        if (res.status === 200 && res.data && res.data.code === 200) {
            // return res.data.data
            const trans = res.data.data;
            if (trans.tx && trans.act && trans.act === 'SUCCESS' && !disableTooltip) {
                const toast = Swal.mixin({
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 3000,
                    timerProgressBar: true,
                    didOpen: (toast) => {
                        toast.addEventListener('mouseenter', Swal.stopTimer);
                        toast.addEventListener('mouseleave', Swal.resumeTimer);
                    },
                });
                // this.disconnect();
                if (trans.status && trans.status === 'SUCCEED') {
                    // success result
                    toast.fire({
                        icon: 'success',
                        title: 'Smart contract submit successfully',
                    });
                } else if (trans.status && trans.status === 'FAILED') {
                    // failed result
                    toast.fire({
                        icon: 'warning',
                        title: 'Smart contract submit failed',
                    });
                }
            }
            return trans;
        }
        if (res.status === 200 && res.data) {
            const errMsg = res.data.msg;
            //TODO error tips
            // error(errMsg);
        }
        return null;
        
    }
    
    private async saveTx(apiHost: string, accessToken: string, method: string, data: any, disableDialog: boolean): Promise<any> {
        
        const headers = {
            'Content-Type': 'application/json',
            'Access-Token': accessToken,
        };
        try {
            const res = await httpRequest.instance.post(`${apiHost}api/v1/oauth2/` + method, data, {headers});
            if (res.status === 200 && res.data && res.data.code === 200) {
                // return res.data.data
                const trans = res.data.data;
                return Promise.resolve(trans);
            }

            return Promise.reject(res.data)
        } catch (e) {
            const result = await Swal.fire({
                html: '<div style=\'text-align: left;\'>The transaction was submitted successfully, but the application is having trouble with tracking the transaction status.</div>',
                showCancelButton: true,
                width: 600,
                confirmButtonText: 'Check again',
            });
            if (result.isConfirmed) {
                return await this.saveTx(apiHost, accessToken, method, data, disableDialog);
            }
            return Promise.reject(e)
        }
    }
    
    private async post(method: string, data: any, httpMethod: string = 'post', returnObj: boolean = false): Promise<any> {
        await this.handleRefreshTokenAsync();
        const headers = {
            'Content-Type': 'application/json',
            'Access-Token': this.token,
        };
        let res;
        if (httpMethod === 'post') {
            res = await axios.post(this.apiHost + `api/v1/oauth2/` + method, data, {headers});
        } else {
            res = await axios.get(this.apiHost + `api/v1/oauth2/` + method, {headers});
        }
        if (res.status === 200 && res.data && res.data.code === 200) {
            // return res.data.data
            const result = res.data.data;
            if (returnObj) {
                return Promise.resolve(res.data);
            }
            return Promise.resolve(result);
        }
        if (res.status === 200 && res.data) {
            //TODO error
            const errMsg = res.data.msg;
        }
        return Promise.reject(res.data);
    }
    
    private async handleRefreshTokenAsync() {
        if (this._polisOauth2Client) {
            this.emit("debug", "refresh token")
            //refresh token
            const oauthInfo = await this._polisOauth2Client?.handleRefreshTokenAsync();
            this.providerOpts.token = oauthInfo.accessToken;
        }
    }
    
    emit(type: any, ...args: any[]): boolean {
        //@ts-ignore
        const events = this._events;
        if (type == "error" && events && !events[type]) {
            this.on(type, function (args) {
                log.error(args);
            })
        }
        return super.emit(type, ...args);
    }
}