export interface NativePeer {role:string;birthId:string;hwnd:number;pid:number;title:string;exe:string;className:string;status:string}
export interface NativeMeshState {self:{hwnd:number;pid:number;title:string};peers:NativePeer[];registered:boolean;observedAt:number}
