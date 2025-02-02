import { enc, MD5 } from 'crypto-js'
import { IBase, ITransport } from './interfaces.ts'

/**
 * Serializer for Speckle objects written in Typescript
 */
export class BaseObjectSerializer {
  constructor(public transports: ITransport[]) {}

  public async SerializeBase(object: object): Promise<SerializedBase> {
    return await this.SerializeBaseWithClosures(object, [])
  }

  private async SerializeBaseWithClosures(object: object, closures: Array<Map<string, number>>) {
    const thisClosure = new Map<string, number>()
    closures.push(thisClosure)

    const converted = await this.PreserializeEachObjectProperty(object, closures)
    let json = this.SerializeMap(converted)
    const id = this.GetId(json)
    converted.set('id', id)

    this.AddSelfToParentClosures(id, closures)
    if (thisClosure.size > 0) {
      converted.set('__closure', Object.fromEntries(thisClosure))
    }
    converted.set('totalChildrenCount', thisClosure.size)

    json = this.SerializeMap(converted)
    await this.StoreObject(converted)
    return new SerializedBase(id, json)
  }

  private async PreserializeObject(
    object: unknown,
    closures: Array<Map<string, number>>,
    detachable: boolean = false,
  ): Promise<unknown> {
    if (!(object instanceof Object) || object instanceof String) {
      return object
    }

    if (detachable) {
      const serialized = await this.SerializeBaseWithClosures(object, [...closures])
      return new ObjectReference(serialized.id)
    }

    if (object instanceof DataChunk) {
      const serialized = await this.SerializeBaseWithClosures(object, [...closures])
      return new ObjectReference(serialized.id)
    }

    if (object instanceof Array) {
      // chunk array into 5000 by default
      const chunkSize = 5000
      if (object.length > chunkSize) {
        let serializedCount = 0
        const data = new Array<DataChunk>()
        while (serializedCount < object.length) {
          const dataChunkCount = Math.min(chunkSize, object.length - serializedCount)
          data.push(new DataChunk(object.slice(serializedCount, serializedCount + dataChunkCount)))
          serializedCount += dataChunkCount
        }
        return await this.PreserializeObject(data, closures)
      }

      const convertedList = new Array<unknown>()
      for (const element of object) {
        convertedList.push(await this.PreserializeObject(element, closures))
      }
      return convertedList
    }

    if (object instanceof Object) {
      return Object.fromEntries(await this.PreserializeEachObjectProperty(object, closures))
    }

    throw new Error(`Cannot serialize object ${object}`)
  }

  private async PreserializeEachObjectProperty(
    o: object,
    closures: Array<Map<string, number>>,
  ): Promise<Map<string, unknown>> {
    const converted = new Map<string, unknown>()

    const getters = Object.entries(Object.getOwnPropertyDescriptors(Reflect.getPrototypeOf(o)))
      .filter(([key, descriptor]) => typeof descriptor.get === 'function' && key !== '__proto__')
      .map(([key]) => key)

    const objectKeys = new Array<string>()
    objectKeys.push(...Object.keys(o))
    objectKeys.push(...getters)

    for (const key of objectKeys) {
      const detachable = key.startsWith('@')
      converted.set(
        BaseObjectSerializer.CleanKey(key),
        await this.PreserializeObject(o[key as keyof object], closures, detachable),
      )
    }

    return converted
  }

  private static disallowedCharacters: string[] = ['.', '/']

  private static CleanKey(originalKey: string): string {
    const newStringChars = []
    for (let i = 0; i < originalKey.length; i++) {
      if (i == 1 && originalKey[i] == '@' && originalKey[0] == '@') {
        continue
      }
      if (this.disallowedCharacters.includes(originalKey[i])) {
        continue
      }

      newStringChars.push(originalKey[i])
    }
    return newStringChars.join('')
  }

  private async StoreObject(object: Map<string, unknown>) {
    for (const transport of this.transports) {
      await transport.SaveObject(object)
    }
  }

  private SerializeMap(map: Map<string, unknown>): string {
    return JSON.stringify(Object.fromEntries(map))
  }

  private GetId(json: string): string {
    return MD5(json).toString(enc.Hex)
  }

  private AddSelfToParentClosures(objectId: string, closureTables: Array<Map<string, number>>) {
    // only go to closureTable length - 1 because the last closure table belongs to the object with the
    // provided id
    const parentClosureTablesCount = closureTables.length - 1

    for (let parentLevel = 0; parentLevel < parentClosureTablesCount; parentLevel++) {
      const childDepth = parentClosureTablesCount - parentLevel
      closureTables[parentLevel].set(objectId, childDepth)
    }
  }
}

export class DataChunk implements IBase {
  public speckle_type = 'Speckle.Core.Models.DataChunk'
  public data: unknown[]

  constructor(data: unknown[] | null) {
    this.data = data ?? []
  }
}

export class ObjectReference implements IBase {
  public speckle_type = 'reference'

  constructor(public referencedId: string) {}
}

export class SerializedBase {
  constructor(
    public id: string,
    public json: string,
  ) {}
}
