/*
* (The MIT License)
* Copyright (c) 2015-2016 YunJiang.Fang <42550564@qq.com>
* @providesModule CacheImage
* @flow-weak
*/


import React from 'react';
import {
	Image,
	ImageBackground,
	StyleSheet,
} from 'react-native';
import { string, number } from 'prop-types';

import fs from 'react-native-fs';
import StorageMgr from './storageMgr.js';
import md5 from './md5.js';


/*
* list status change graph
* STATUS_LOADING->[STATUS_LOADED, STATUS_UNLOADED]
*/
const
STATUS_LOADING = 1,
STATUS_LOADED = 2,
STATUS_UNLOADED = 3;


let storageMgr = null;
let syncImageSource = {};
let cacheIdMgr = {};

class CacheImage extends React.PureComponent { 

	addImageRef = async (url, size) => {
		try {
			storageMgr.realm.write(() => {
				realm.create('CacheImage', {
					url,
					ref: 1,
					size,
					time: parseInt(Date.now() / 1000)
				})
			}, true);
			return true;
		} catch(e) {
			return false;
		}
	}

	 subImageRef = async (url) => {
			const q = storageMgr.realm.objects('CacheImage').filtered(`url="${url}"`);
			if (q.length){
				const item = q[0];
				const { ref, size } = item;

				if (ref === 1) {
					storageMgr.realm.delete(item);
					fs.unlink(storageMgr.getCacheFilePath(url));
					storageMgr.updateStorage(-size);
				} else {
					storageMgr.realm.write(() => {
						storageMgr.realm.create('CacheImage', {
							url,
							ref: ref - 1
						})
					}, true);
				}
				return true;
			}
			return false;
	}

  async checkCacheId(id, url, size) {
    return new Promise(resolve => {
      const q = storageMgr.realm.objects('CacheID').filtered(`id="${id}"`);
      try {
        if(q.length){
          const { url: oldurl } = q[0];
          if(url !== oldurl ) {
            storageMgr.realm.write(() => {
              storageMgr.realm.create('CacheID', {
                id: id,
                url: url
              });
              this.addImageRef(url, size);
              this.subImageRef(oldurl);
              this.unlock();
              resolve(true);
            }, true);
          }else{
            this.unlock();
            resolve(true);
          }
        }else{
          storageMgr.realm.write(() => {
            storageMgr.realm.create('CacheID', {
              id: id,
              url: url
            });
            this.addImageRef(url, size);
            this.unlock();
            resolve(true);
          }, true);
        }
      } catch(e){
        resolve(false);
        this.unlock();
      }
    });
	}
	
  async deleteCacheImage(storage) {
		const { id, url: mainUrl } = storageMgr.realm.objects('CacheImage').sorted('time').slice(0, 1);
		const realmCacheImage = storageMgr.realm.objects('CacheImage').filtered(`id="${id}"`);
		if (realmCacheImage.length) {
			const item = realmCacheImage[0];
			const { url, size } = item;
			storageMgr.realm.objects('CacheImage').remove(item);
			const item2 = storageMgr.realm.objects('CacheID').filtered(`url="${mainUrl}"`);
			storageMgr.realm.objects('CacheID').remove(item2);
			storage -= size;
			fs.unlink(storageMgr.getCacheFilePath(url));
			storageMgr.updateStorage(-size);
			return storage;
		}
	}
	
  async checkCacheStorage(size) {
		let storage = storageMgr.storage + size;
		while (storage >= StorageMgr.CACHE_IMAGE_SIZE) {
			storage = await this.deleteCacheImage(storage);
		}
	}
	
  async isFileExist(filepath) {
		try {
			await fs.stat(filepath)
		} catch (e) {
			return false;
		}
    return true;
	}
	
  async downloadImage(url, filepath, cacheId, filename) {
      const ret = fs.downloadFile({
				fromUrl: url,
				background: true,
				toFile: filepath,
			});
			try {
				const res = await ret.promise
				if (res.statusCode !== 200) {
					this.unlock();
					this.setState({
						status:STATUS_UNLOADED,
					});
				} else {
					this.setState({
						status: STATUS_LOADED,
						source: { uri: `file://${filepath}`  },
					});
					await this.checkCacheId(cacheId, filename, res.bytesWritten);
					await storageMgr.updateStorage(res.bytesWritten);
					await this.checkCacheStorage(res.bytesWritten);
				}
			} catch(e) {
				this.unlock();
        this.setState({
          status:STATUS_UNLOADED,
        });
			}

       
	}
	
  checkImageSource(cacheId, url) {
    const type = url.replace(/.*\.(.*)/, '$1');
    if (type.length < 3 || type.length > 4){
      // TODO: dynamic url to take mime type what is using image
      type = 'jpg';
    }
    const filename =  `${md5(url)}.${type}`;
    const filepath = storageMgr.getCacheFilePath(filename);
    this.param = { cacheId, url, filename, filepath };
    this.syncCheckImageSource();
  }

  lock() {
      syncImageSource[this.param.filename] = true;
  }

  unlock() {
      delete syncImageSource[this.param.filename];
  }

  islock() {
      return syncImageSource[this.param.filename];
  }

  syncCheckImageSource() {
      if (this.islock()) {
          this.timeout = setTimeout(this.syncCheckImageSource, 100);
      } else {
					this.timeout = null;
          this.doCheckImageSource();
      }
  }

  async doCheckImageSource() {
		const { cacheId, url, filename, filepath } = this.param;
		this.lock();
		const isExist = await this.isFileExist(filepath);

		if (isExist) {
				this.setState({
					status: STATUS_LOADED,
					source: { uri:`file://${filepath}` },
				});
				this.checkCacheId(cacheId, filename);
		} else {
				this.downloadImage(url, filepath, cacheId, filename);
		}
	}
	
  constructor(props) {
		super(props)
		const { cacheId, url } = props;
		if (cacheIdMgr[cacheId]) {
				console.error('duplicate cacheId');
				return;
		}
		cacheIdMgr[cacheId] = true;
		this.state = {
			status: STATUS_LOADING,
			source: null
		};
		this.timeout = null;
		this.checkImageSource(cacheId, url);
  }

  componentWillUnmount() {
		delete cacheIdMgr[this.props.cacheId];
		if (this.timeout) clearTimeout(this.timeout);
  }

  renderLoading() {
		return (
			<ImageBackground
					{...this.props}
					style={[this.props.style, {justifyContent:'center', alignItems:'center'}]}
					>
					<Image
						style={styles.spinner}
						source={{
							uri: 'data:image/gif;base64,R0lGODlhIAAgALMAAP///7Ozs/v7+9bW1uHh4fLy8rq6uoGBgTQ0NAEBARsbG8TExJeXl/39/VRUVAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFBQAAACwAAAAAIAAgAAAE5xDISSlLrOrNp0pKNRCdFhxVolJLEJQUoSgOpSYT4RowNSsvyW1icA16k8MMMRkCBjskBTFDAZyuAEkqCfxIQ2hgQRFvAQEEIjNxVDW6XNE4YagRjuBCwe60smQUDnd4Rz1ZAQZnFAGDd0hihh12CEE9kjAEVlycXIg7BAsMB6SlnJ87paqbSKiKoqusnbMdmDC2tXQlkUhziYtyWTxIfy6BE8WJt5YEvpJivxNaGmLHT0VnOgGYf0dZXS7APdpB309RnHOG5gDqXGLDaC457D1zZ/V/nmOM82XiHQjYKhKP1oZmADdEAAAh+QQFBQAAACwAAAAAGAAXAAAEchDISasKNeuJFKoHs4mUYlJIkmjIV54Soypsa0wmLSnqoTEtBw52mG0AjhYpBxioEqRNy8V0qFzNw+GGwlJki4lBqx1IBgjMkRIghwjrzcDti2/Gh7D9qN774wQGAYOEfwCChIV/gYmDho+QkZKTR3p7EQAh+QQFBQAAACwBAAAAHQAOAAAEchDISWdANesNHHJZwE2DUSEo5SjKKB2HOKGYFLD1CB/DnEoIlkti2PlyuKGEATMBaAACSyGbEDYD4zN1YIEmh0SCQQgYehNmTNNaKsQJXmBuuEYPi9ECAU/UFnNzeUp9VBQEBoFOLmFxWHNoQw6RWEocEQAh+QQFBQAAACwHAAAAGQARAAAEaRDICdZZNOvNDsvfBhBDdpwZgohBgE3nQaki0AYEjEqOGmqDlkEnAzBUjhrA0CoBYhLVSkm4SaAAWkahCFAWTU0A4RxzFWJnzXFWJJWb9pTihRu5dvghl+/7NQmBggo/fYKHCX8AiAmEEQAh+QQFBQAAACwOAAAAEgAYAAAEZXCwAaq9ODAMDOUAI17McYDhWA3mCYpb1RooXBktmsbt944BU6zCQCBQiwPB4jAihiCK86irTB20qvWp7Xq/FYV4TNWNz4oqWoEIgL0HX/eQSLi69boCikTkE2VVDAp5d1p0CW4RACH5BAUFAAAALA4AAAASAB4AAASAkBgCqr3YBIMXvkEIMsxXhcFFpiZqBaTXisBClibgAnd+ijYGq2I4HAamwXBgNHJ8BEbzgPNNjz7LwpnFDLvgLGJMdnw/5DRCrHaE3xbKm6FQwOt1xDnpwCvcJgcJMgEIeCYOCQlrF4YmBIoJVV2CCXZvCooHbwGRcAiKcmFUJhEAIfkEBQUAAAAsDwABABEAHwAABHsQyAkGoRivELInnOFlBjeM1BCiFBdcbMUtKQdTN0CUJru5NJQrYMh5VIFTTKJcOj2HqJQRhEqvqGuU+uw6AwgEwxkOO55lxIihoDjKY8pBoThPxmpAYi+hKzoeewkTdHkZghMIdCOIhIuHfBMOjxiNLR4KCW1ODAlxSxEAIfkEBQUAAAAsCAAOABgAEgAABGwQyEkrCDgbYvvMoOF5ILaNaIoGKroch9hacD3MFMHUBzMHiBtgwJMBFolDB4GoGGBCACKRcAAUWAmzOWJQExysQsJgWj0KqvKalTiYPhp1LBFTtp10Is6mT5gdVFx1bRN8FTsVCAqDOB9+KhEAIfkEBQUAAAAsAgASAB0ADgAABHgQyEmrBePS4bQdQZBdR5IcHmWEgUFQgWKaKbWwwSIhc4LonsXhBSCsQoOSScGQDJiWwOHQnAxWBIYJNXEoFCiEWDI9jCzESey7GwMM5doEwW4jJoypQQ743u1WcTV0CgFzbhJ5XClfHYd/EwZnHoYVDgiOfHKQNREAIfkEBQUAAAAsAAAPABkAEQAABGeQqUQruDjrW3vaYCZ5X2ie6EkcKaooTAsi7ytnTq046BBsNcTvItz4AotMwKZBIC6H6CVAJaCcT0CUBTgaTg5nTCu9GKiDEMPJg5YBBOpwlnVzLwtqyKnZagZWahoMB2M3GgsHSRsRACH5BAUFAAAALAEACAARABgAAARcMKR0gL34npkUyyCAcAmyhBijkGi2UW02VHFt33iu7yiDIDaD4/erEYGDlu/nuBAOJ9Dvc2EcDgFAYIuaXS3bbOh6MIC5IAP5Eh5fk2exC4tpgwZyiyFgvhEMBBEAIfkEBQUAAAAsAAACAA4AHQAABHMQyAnYoViSlFDGXBJ808Ep5KRwV8qEg+pRCOeoioKMwJK0Ekcu54h9AoghKgXIMZgAApQZcCCu2Ax2O6NUud2pmJcyHA4L0uDM/ljYDCnGfGakJQE5YH0wUBYBAUYfBIFkHwaBgxkDgX5lgXpHAXcpBIsRADs=',
							isStatic: true
						}}
					/>
			</ImageBackground>
		);
  }

  renderLocalFile() {
    const { source } = this.state;

    return (
      <Image
          {...this.props}
          source={source}
      />
    );
  }

  updateSize() {
    try {
			const { status, source } = this.state;
			const { getSize } = this.props;
      if (getSize && source && status === STATUS_LOADED) {
        Image.getSize(source.uri, (width, height) => {
          getSize(this, width, height);
        });
      }
    } catch(e) {

		}
  }

  render() {
		const { status } = this.state;
		if (status !== STATUS_LOADING){
      this.updateSize();
    }
		switch(status) {
			case STATUS_LOADING:
				return this.renderLoading();
			case STATUS_LOADED:
				return this.renderLocalFile();
			default:
				return (
					<Image
						{...this.props}
					/>
				)
		}
	}
}

CacheImage.propTypes = {
	url: string.isRequired,
	cacheId: number.isRequired
};

CacheImage.getSchemaRealm = StorageMgr.getSchema;

CacheImage.setup = (realm) => {
  storageMgr = new StorageMgr(realm);
  CacheImage.clear = storageMgr.clear;
};

export default CacheImage;

const styles = StyleSheet.create({
  spinner: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 25,
    height: 25,
    backgroundColor: 'transparent',
  },
});
