import assert from 'assert'

import { ethers, Contract } from 'ethers'
import { Provider } from '@ethersproject/abstract-provider'
import { Signer } from '@ethersproject/abstract-signer'
import { sleep, getChainId } from '@eth-optimism/core-utils'

export const deployAndVerifyAndThen = async ({
  hre,
  name,
  args,
  contract,
  iface,
  postDeployAction,
}: {
  hre: any
  name: string
  args: any[]
  contract?: string
  iface?: string
  postDeployAction?: (contract: Contract) => Promise<void>
}) => {
  const { deploy } = hre.deployments
  const { deployer } = await hre.getNamedAccounts()

  const result = await deploy(name, {
    contract,
    from: deployer,
    args,
    log: true,
    waitConfirmations: hre.deployConfig.numDeployConfirmations,
  })

  await hre.ethers.provider.waitForTransaction(result.transactionHash)

  if (result.newlyDeployed) {
    if (!(await isHardhatNode(hre)) && hre.network.config.live !== false) {
      // Verification sometimes fails, even when the contract is correctly deployed and eventually
      // verified. Possibly due to a race condition. We don't want to halt the whole deployment
      // process just because that happens.
      try {
        console.log('Verifying on Etherscan...')
        await hre.run('verify:verify', {
          address: result.address,
          constructorArguments: args,
        })
        console.log('Successfully verified on Etherscan')
      } catch (error) {
        console.log('Error when verifying bytecode on Etherscan:')
        console.log(error)
      }

      try {
        console.log('Verifying on Sourcify...')
        await hre.run('sourcify')
        console.log('Successfully verified on Sourcify')
      } catch (error) {
        console.log('Error when verifying bytecode on Sourcify:')
        console.log(error)
      }
    }
    if (postDeployAction) {
      const signer = hre.ethers.provider.getSigner(deployer)
      let abi = result.abi
      if (iface !== undefined) {
        const factory = await hre.ethers.getContractFactory(iface)
        abi = factory.interface
      }
      await postDeployAction(
        getAdvancedContract({
          hre,
          contract: new Contract(result.address, abi, signer),
        })
      )
    }
  }
}

// Returns a version of the contract object which modifies all of the input contract's methods to:
// 1. Waits for a confirmed receipt with more than deployConfig.numDeployConfirmations confirmations.
// 2. Include simple resubmission logic, ONLY for Kovan, which appears to drop transactions.
export const getAdvancedContract = (opts: {
  hre: any
  contract: Contract
}): Contract => {
  // Temporarily override Object.defineProperty to bypass ether's object protection.
  const def = Object.defineProperty
  Object.defineProperty = (obj, propName, prop) => {
    prop.writable = true
    return def(obj, propName, prop)
  }

  const contract = new Contract(
    opts.contract.address,
    opts.contract.interface,
    opts.contract.signer || opts.contract.provider
  )

  // Now reset Object.defineProperty
  Object.defineProperty = def

  // Override each function call to also `.wait()` so as to simplify the deploy scripts' syntax.
  for (const fnName of Object.keys(contract.functions)) {
    const fn = contract[fnName].bind(contract)
    ;(contract as any)[fnName] = async (...args: any) => {
      // We want to use the gas price that has been configured at the beginning of the deployment.
      // However, if the function being triggered is a "constant" (static) function, then we don't
      // want to provide a gas price because we're prone to getting insufficient balance errors.
      let gasPrice: number | undefined
      try {
        gasPrice = opts.hre.deployConfig.gasPrice
      } catch (err) {
        // Fine, no gas price
      }

      if (contract.interface.getFunction(fnName).constant) {
        gasPrice = 0
      }

      const tx = await fn(...args, {
        gasPrice,
      })

      if (typeof tx !== 'object' || typeof tx.wait !== 'function') {
        return tx
      }

      // Special logic for:
      // (1) handling confirmations
      // (2) handling an issue on Kovan specifically where transactions get dropped for no
      //     apparent reason.
      const maxTimeout = 120
      let timeout = 0
      while (true) {
        await sleep(1000)
        const receipt = await contract.provider.getTransactionReceipt(tx.hash)
        if (receipt === null) {
          timeout++
          if (timeout > maxTimeout && opts.hre.network.name === 'kovan') {
            // Special resubmission logic ONLY required on Kovan.
            console.log(
              `WARNING: Exceeded max timeout on transaction. Attempting to submit transaction again...`
            )
            return contract[fnName](...args)
          }
        } else if (
          receipt.confirmations >= opts.hre.deployConfig.numDeployConfirmations
        ) {
          return tx
        }
      }
    }
  }

  return contract
}

export const getContractFromArtifact = async (
  hre: any,
  name: string,
  options: {
    iface?: string
    signerOrProvider?: Signer | Provider | string
  } = {}
): Promise<ethers.Contract> => {
  const artifact = await hre.deployments.get(name)
  await hre.ethers.provider.waitForTransaction(artifact.receipt.transactionHash)

  // Get the deployed contract's interface.
  let iface = new hre.ethers.utils.Interface(artifact.abi)
  // Override with optional iface name if requested.
  if (options.iface) {
    const factory = await hre.ethers.getContractFactory(options.iface)
    iface = factory.interface
  }

  let signerOrProvider: Signer | Provider = hre.ethers.provider
  if (options.signerOrProvider) {
    if (typeof options.signerOrProvider === 'string') {
      signerOrProvider = hre.ethers.provider.getSigner(options.signerOrProvider)
    } else {
      signerOrProvider = options.signerOrProvider
    }
  }

  return getAdvancedContract({
    hre,
    contract: new hre.ethers.Contract(
      artifact.address,
      iface,
      signerOrProvider
    ),
  })
}

const isHardhatNode = async (hre) => {
  return (await getChainId(hre.ethers.provider)) === 31337
}

export const assertContractVariable = async (
  contract: ethers.Contract,
  variable: string,
  expected: any
) => {
  // Need to make a copy that doesn't have a signer or we get the error that contracts with
  // signers cannot override the from address.
  const temp = new ethers.Contract(
    contract.address,
    contract.interface,
    contract.provider
  )

  const actual = await temp.callStatic[variable]({
    from: ethers.constants.AddressZero,
  })

  assert(
    actual === expected || (actual.eq && actual.eq(expected)),
    `[FATAL] ${variable} is ${actual} but should be ${expected}`
  )
}

export const getDeploymentAddress = async (
  hre: any,
  name: string
): Promise<string> => {
  const deployment = await hre.deployments.get(name)
  return deployment.address
}

// Large balance to fund accounts with.
export const BIG_BALANCE = ethers.BigNumber.from(`0xFFFFFFFFFFFFFFFFFFFF`)
